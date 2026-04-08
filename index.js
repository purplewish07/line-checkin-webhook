// index.js
// Express server for LINE LIFF GPS clock-in with Google Sheets integration
// Includes: raw body capture for LINE signature verification, CORS, improved /liff-clock responses

const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const fetch = require('node-fetch');

const app = express();

// ========== Configuration from environment ==========
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const SHEET_NAME = process.env.SHEET_NAME || '考勤表';
const SERVICE_ACCOUNT_KEY_JSON = process.env.SERVICE_ACCOUNT_KEY_JSON || null;
const LIFF_ID = process.env.LIFF_ID || '';
const OFFICE_LAT_ENV = process.env.OFFICE_LAT;
const OFFICE_LNG_ENV = process.env.OFFICE_LNG;
const MAX_DISTANCE_ENV = process.env.MAX_DISTANCE;
const AUTO_CLOSE_MS = process.env.AUTO_CLOSE_MS ? Number(process.env.AUTO_CLOSE_MS) : 500;
// =====================================================

// Parse JSON and capture raw body for LINE signature verification
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
  }
}));

// Simple CORS for LIFF frontend calls (adjust origin for production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change to your domain in production
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Line-Signature');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static LIFF page from public/
app.use(express.static('public'));

// ----------------- Utilities -----------------

/**
 * Verify LINE signature using raw request body.
 * LINE sends X-Line-Signature header which is HMAC-SHA256 of raw body (base64).
 */
function verifySignature(req) {
  const signature = req.get('X-Line-Signature') || req.get('x-line-signature');
  if (!signature) return false;
  const body = req.rawBody || '';
  const hash = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

/**
 * Create Google Sheets client using service account JSON string in env.
 */
async function getSheetsClient() {
  if (!SERVICE_ACCOUNT_KEY_JSON) throw new Error('Missing SERVICE_ACCOUNT_KEY_JSON environment variable');
  let key;
  try {
    key = JSON.parse(SERVICE_ACCOUNT_KEY_JSON);
  } catch (e) {
    throw new Error('SERVICE_ACCOUNT_KEY_JSON is not valid JSON');
  }
  const jwtClient = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await jwtClient.authorize();
  return google.sheets({ version: 'v4', auth: jwtClient });
}

/**
 * Format timestamp to Asia/Taipei human readable string.
 */
function formatTime(ts) {
  const d = new Date(Number(ts));
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(d).replace(/\//g, '/');
}

/**
 * Reply message using replyToken (if provided).
 */
async function replyMessage(replyToken, message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('No LINE_CHANNEL_ACCESS_TOKEN set; skip reply');
    return;
  }
  if (!replyToken) {
    console.log('No replyToken provided; skipping replyMessage');
    return;
  }
  try {
    const url = 'https://api.line.me/v2/bot/message/reply';
    const payload = { replyToken, messages: [{ type: 'text', text: message }] };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    if (resp.status >= 400) console.warn('replyMessage failed', resp.status, text);
    else console.log('replyMessage ok', resp.status);
  } catch (err) {
    console.error('replyMessage error', err);
  }
}

/**
 * Safely fetch displayName for a userId. Returns userId if fetch fails.
 */
async function getUsernameSafe(userId) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return userId;
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const resp = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN } });
    if (resp.status === 200) {
      const j = await resp.json();
      return j.displayName || userId;
    } else {
      console.warn('profile fetch failed', resp.status, await resp.text());
      return userId;
    }
  } catch (err) {
    console.error('getUsernameSafe error', err);
    return userId;
  }
}

/**
 * Haversine formula to compute distance in meters between two lat/lng points.
 */
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ----------------- Google Sheets handlers -----------------

/**
 * Append a clock-in row.
 * Row format: [userId, username, inTime, outTime, status]
 */
async function handleClockIn(sheets, data, replyToken) {
  try {
    const readRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:E` }).catch(() => ({ data: { values: [] } }));
    const rows = readRes.data.values || [];
    let hasOpenIn = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const uid = r[0] || '';
      const inTime = r[2] || '';
      const outTime = r[3] || '';
      if (uid === data.userId && inTime && !outTime) { hasOpenIn = true; break; }
    }
    if (hasOpenIn) {
      await replyMessage(replyToken, '您已有未配對的上班紀錄，請先打下班或聯絡人資。');
      return;
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[data.userId, data.username || 'unknown', data.timeStr, '', '上班']] }
    });
    await replyMessage(replyToken, `上班打卡成功：${data.username} ${data.timeStr}`);
  } catch (err) {
    console.error('handleClockIn error', err);
    await replyMessage(replyToken, '系統錯誤，請稍後再試。');
  }
}

/**
 * Update the latest open clock-in row with outTime.
 */
async function handleClockOut(sheets, data, replyToken) {
  try {
    const readRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:E` }).catch(() => ({ data: { values: [] } }));
    const rows = readRes.data.values || [];
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const uid = r[0] || '';
      const inTime = r[2] || '';
      const outTime = r[3] || '';
      if (uid === data.userId && inTime && !outTime) { targetRow = i + 1; break; } // sheet rows are 1-indexed
    }
    if (targetRow === -1) {
      await replyMessage(replyToken, '找不到可配對的上班紀錄，請先打上班或申請補打卡。');
      return;
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!D${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[data.timeStr]] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!E${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['下班']] }
    });
    await replyMessage(replyToken, `下班打卡成功：${data.username} ${data.timeStr}`);
  } catch (err) {
    console.error('handleClockOut error', err);
    await replyMessage(replyToken, '系統錯誤，請稍後再試。');
  }
}

// ----------------- Routes -----------------

/**
 * LINE webhook endpoint for text commands (e.g., "上班", "下班")
 * Verifies signature using raw body.
 */
app.post('/', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      console.warn('Invalid signature for webhook');
      return res.status(401).json({ status: 401, message: 'Invalid signature' });
    }

    const body = req.body || {};
    const events = body.events || [];
    // Immediately respond 200 to LINE
    res.status(200).json({ status: 200 });

    // Process events asynchronously
    const sheets = await getSheetsClient();
    for (const event of events) {
      try {
        if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') continue;
        const message = event.message.text.trim();
        const replyToken = event.replyToken;
        const userId = event.source && event.source.userId;
        const timestamp = event.timestamp || Date.now();
        if (!userId) {
          await replyMessage(replyToken, '無法取得使用者 ID，請重新開啟對話後再試。');
          continue;
        }
        if (message === '上班' || message === '下班') {
          const username = await getUsernameSafe(userId);
          const timeStr = formatTime(timestamp);
          const data = { userId, username, timeStr };
          if (message === '上班') await handleClockIn(sheets, data, replyToken);
          else await handleClockOut(sheets, data, replyToken);
        }
      } catch (err) {
        console.error('event processing error', err);
      }
    }
  } catch (err) {
    console.error('webhook error', err);
    if (!res.headersSent) res.status(500).send('Server error');
  }
});

/**
 * LIFF UI POST endpoint for GPS-based clock
 * Expects JSON: { userId, latitude, longitude, type }
 * Returns JSON including status, message, distance, officeLat, officeLng, lat, lng
 */
app.post('/liff-clock', async (req, res) => {
  try {
    const { userId, latitude, longitude, type } = req.body || {};
    if (!userId) return res.json({ status: 'error', message: '缺少 userId' });
    if (typeof latitude === 'undefined' || typeof longitude === 'undefined') return res.json({ status: 'error', message: '缺少 GPS 位置' });

    // Read office coordinates and distance from environment (if provided), otherwise fall back to defaults
    const officeLat = OFFICE_LAT_ENV ? Number(OFFICE_LAT_ENV) : 24.229525;
    const officeLng = OFFICE_LNG_ENV ? Number(OFFICE_LNG_ENV) : 120.667834;
    const maxDistance = MAX_DISTANCE_ENV ? Number(MAX_DISTANCE_ENV) : 100;

    const distance = getDistance(Number(latitude), Number(longitude), officeLat, officeLng);
    // If distance too far, return error with details for frontend display
    if (distance > maxDistance) {
      return res.json({
        status: 'error',
        message: `您距離公司太遠（${Math.round(distance)} 公尺）`,
        lat: Number(latitude),
        lng: Number(longitude),
        distance: Math.round(distance),
        officeLat,
        officeLng
      });
    }

    const sheets = await getSheetsClient();
    const username = await getUsernameSafe(userId);
    const timeStr = formatTime(Date.now());
    const data = { userId, username, timeStr };

    // type 可為 'clock_in' 或 'clock_out' 或 'auto'
    if (type === 'clock_in' || type === '上班') {
      await handleClockIn(sheets, data, null); // replyToken 為 null，LIFF 前端可選擇發訊息
      return res.json({
        status: 'success',
        message: `${username} 上班打卡成功 ${timeStr}`,
        lat: Number(latitude),
        lng: Number(longitude),
        distance: Math.round(distance),
        officeLat,
        officeLng
      });
    }

    if (type === 'clock_out' || type === '下班') {
      await handleClockOut(sheets, data, null);
      return res.json({
        status: 'success',
        message: `${username} 下班打卡成功 ${timeStr}`,
        lat: Number(latitude),
        lng: Number(longitude),
        distance: Math.round(distance),
        officeLat,
        officeLng
      });
    }

    if (type === 'auto') {
      // 判斷是否有未配對上班紀錄
      const readRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:E` }).catch(() => ({ data: { values: [] } }));
      const rows = readRes.data.values || [];
      let hasOpenIn = false;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const uid = r[0] || '';
        const inTime = r[2] || '';
        const outTime = r[3] || '';
        if (uid === userId && inTime && !outTime) { hasOpenIn = true; break; }
      }
      if (hasOpenIn) {
        await handleClockOut(sheets, data, null);
        return res.json({
          status: 'success',
          message: `${username} 下班打卡成功 ${timeStr}`,
          lat: Number(latitude),
          lng: Number(longitude),
          distance: Math.round(distance),
          officeLat,
          officeLng
        });
      } else {
        await handleClockIn(sheets, data, null);
        return res.json({
          status: 'success',
          message: `${username} 上班打卡成功 ${timeStr}`,
          lat: Number(latitude),
          lng: Number(longitude),
          distance: Math.round(distance),
          officeLat,
          officeLng
        });
      }
    }

    return res.json({ status: 'error', message: '未知的打卡類型' });
  } catch (err) {
    console.error('/liff-clock error', err);
    return res.json({ status: 'error', message: '系統錯誤' });
  }
});

// Expose a small non-sensitive config endpoint for the LIFF frontend to load runtime config.
app.get('/config', (req, res) => {
  const officeLat = OFFICE_LAT_ENV ? Number(OFFICE_LAT_ENV) : 24.229525;
  const officeLng = OFFICE_LNG_ENV ? Number(OFFICE_LNG_ENV) : 120.667834;
  const maxDistance = MAX_DISTANCE_ENV ? Number(MAX_DISTANCE_ENV) : 100;
  const cloudRunUrl = '/liff-clock'; // frontend can use relative path
  res.json({
    liffId: LIFF_ID,
    cloudRunUrl,
    officeLat,
    officeLng,
    maxDistance,
    autoCloseMs: AUTO_CLOSE_MS
  });
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));
