// server.js
require('dotenv').config({ quiet: true });
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

/**
 * 必須環境変数チェック（未設定なら起動しない）
 */
const REQUIRED_ENV_VARS = [
    'LOGIN_PASSWORD',
    'JWT_SECRET',
    'REFRESH_TOKEN_SECRET',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_CONTACT_EMAIL',
    'CLIENT_URL',
  ];

const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
// 起動時に落として「必ず環境変数を設定させる」
console.error(
    'Missing required environment variables:',
    missing.join(', ')
);
console.error(
    'Please create a .env based on .env.example and set the above variables.'
);
process.exit(1);
}

// --- CORS設定を強化 ---
const corsOptions = {
    origin: process.env.CLIENT_URL, // 必須
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200,
  };
  app.use(cors(corsOptions));

// --- 永続化用ファイル ---
const DATA_FILE = path.join(__dirname, 'data.json');

// --- セキュリティ関連 ---
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

// --- VAPID設定 ---
const rawContact = process.env.VAPID_CONTACT_EMAIL.trim();
const VAPID_CONTACT_EMAIL = rawContact.startsWith('mailto:')
  ? rawContact
  : `mailto:${rawContact}`;

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

webpush.setVapidDetails(
    VAPID_CONTACT_EMAIL,
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// ログ関数
function log(msg, type = 'info') {
    console.log(`[${type}] ${msg}`);
}

// データ読み込み
async function loadData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // ファイルがない場合は初期データ
        return {
            authCodes: {},
            registrations: {}
        };
    }
}

// データ保存
async function saveData(data) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// ヘルスチェック
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Emergency Call System',
        version: '2.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});


// --- シンプルなログイン（管理用） ---
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password !== LOGIN_PASSWORD) {
      log('Invalid login password', 'warn');
      return res
        .status(401)
        .json({ success: false, error: 'Invalid password' });
    }

    // ログイン成功時、1時間有効な一時トークンを生成
    const token = jwt.sign({ authorized: true }, JWT_SECRET, {
      expiresIn: '1h',
    });
  
    res.json({ success: true, token });
    log('Admin login success');
  });


// VAPID PUBLIC KEYをクライアントに渡す
app.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

// --- JWT検証ミドルウェア（管理系API保護用） ---
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer xxx"
  
    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: 'Unauthorized: No token provided' });
    }
  
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res
          .status(403)
          .json({ success: false, error: 'Forbidden: Invalid token' });
      }
      req.user = user;
      next();
    });
  }

// プッシュ通知送信API
app.post('/send-notification', verifyToken, async (req, res) => {
    try {
        const { receiverId, sessionId, senderId, title, body } = req.body;
        
        if (!receiverId || !sessionId) {
            return res.status(400).json({
                success: false,
                error: 'receiverId and sessionId are required'
            });
        }
        
        // データ読み込み
        const data = await loadData();
        
        // 受信者の購読情報取得
        const registration = data.registrations[receiverId];
        
        if (!registration || !registration.subscription) {
            return res.status(404).json({
                success: false,
                error: 'Receiver not registered'
            });
        }
        
        // 通知ペイロード作成
        const payload = JSON.stringify({
            title: title || '🚨 Emergency Call',
            body: body || 'You have a new emergency call.',
            sessionId: sessionId,
            senderId: senderId,
            url: process.env.CLIENT_URL,
            timestamp: Date.now()
        });
        
        // プッシュ通知送信
        await webpush.sendNotification(registration.subscription, payload);
        
        log(`Notification sent to receiverId=${receiverId}, sessionId=${sessionId}`);

        res.json({
            success: true,
            message: 'Notification sent',
            sessionId,
          });
        } catch (error) {
            console.error('[send-notification] error:', error.message);
        
        // 購読が無効な場合は削除
        if (error.statusCode === 410) {
            const data = await loadData();
            delete data.registrations[req.body.receiverId];
            await saveData(data);
            log(`Cleaned up stale registration for ${req.body.receiverId}`, 'info');
        }
        
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 登録状況確認API（デバッグ用）
app.get('/status', async (req, res) => {
    try {
        const data = await loadData();
        res.json({
            authCodesCount: Object.keys(data.authCodes).length,
            registrationsCount: Object.keys(data.registrations).length,
            authCodes: Object.keys(data.authCodes),
            registrations: Object.keys(data.registrations)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 認証コード生成API
app.post('/generate-auth-code', async (req, res) => {
    try {
        const { receiverId } = req.body;
        
        if (!receiverId) {
            return res.status(400).json({
                success: false,
                error: 'receiverId is required'
            });
        }
        
        // 6桁の認証コード生成
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // データ読み込み
        const data = await loadData();
        
        // 認証コード保存（30分有効）
        data.authCodes[receiverId] = {
            code: code,
            expires: Date.now() + 30 * 60 * 1000,
            createdAt: new Date().toISOString()
        };
        
        await saveData(data);
        
        log(`Auth code generated for receiverId=${receiverId} code=${code}`);
        
        res.json({
            success: true,
            code: code,
            expiresIn: '30分'
        });
        
    } catch (error) {
        console.error('[generate-auth-code] error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 受信者登録API
app.post('/register', async (req, res) => {
    try {
        const { receiverId, authCode, subscription } = req.body;
        
        if (!receiverId || !authCode || !subscription) {
            return res.status(400).json({
                success: false,
                error: 'receiverId, authCode and subscription are required',
            });
        }
        
        // データ読み込み
        const data = await loadData();
        
        // 認証コード検証
        const storedAuth = data.authCodes[receiverId];
        
        if (!storedAuth) {
            return res.status(401).json({
                success: false,
                error: 'No auth code found'
            });
        }
        
        if (storedAuth.code !== authCode) {
            return res.status(401).json({
                success: false,
                error: 'Invalid auth code'
            });
        }
        
        if (storedAuth.expires < Date.now()) {
            // 期限切れの認証コードを削除
            delete data.authCodes[receiverId];
            await saveData(data);
            
            return res.status(401).json({
                success: false,
                error: 'Auth code expired' 
            });
        }
        
        // 受信者登録
        data.registrations[receiverId] = {
            subscription: subscription,
            registeredAt: new Date().toISOString()
        };
        
        // 使用済み認証コードを削除
        delete data.authCodes[receiverId];
        
        await saveData(data);
        
        log(`Receiver registered: ${receiverId}`);

        // アクセストークンとリフレッシュトークンを生成
        const accessToken = jwt.sign({ receiverId: receiverId }, JWT_SECRET, { 
            expiresIn: '15m',
        });
        const refreshToken = jwt.sign({ receiverId: receiverId }, REFRESH_TOKEN_SECRET, {
            expiresIn: '30d',
        });

        res.json({ 
            success: true, 
            accessToken, 
            refreshToken,
            message: 'Receiver registered',
         }); // 2つのトークンを返す
    } catch (error) {
        console.error('[register] error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ... 既存の app.post('/register', ...) の後などに追加 ...

/**
 * 購読更新API (authCode不要、refreshTokenで本人確認)
 */
app.post('/update-subscription', async (req, res) => {
    try {
      const { receiverId, refreshToken, subscription } = req.body;
      if (!receiverId || !refreshToken || !subscription) {
        return res.status(400).json({ success: false, error: 'Missing parameters' });
      }
  
      // refreshToken の検証
      let decoded;
      try {
        decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
      } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid refresh token' });
      }
  
      if (!decoded || decoded.receiverId !== receiverId) {
        return res.status(403).json({ success: false, error: 'Forbidden: ID mismatch' });
      }
  
      const data = await loadData();
      
      // 既存の登録情報を更新（または新規作成）
      data.registrations[receiverId] = {
        subscription,
        updatedAt: new Date().toISOString(),
        registeredAt: data.registrations[receiverId]?.registeredAt || new Date().toISOString()
      };
      
      await saveData(data);
      log(`Subscription auto-updated for receiverId=${receiverId}`);
  
      return res.json({ success: true });
    } catch (e) {
      console.error('[update-subscription] error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  
// --- アクセストークン更新 ---
app.post('/refresh-token', (req, res) => {
    const { token } = req.body;

    if (!token) return res.sendStatus(401);

    jwt.verify(token, REFRESH_TOKEN_SECRET, (err, user) => {
        if (err) {
            log('[refresh-token] invalid token', 'warn');
            return res.sendStatus(403); // Forbidden
        }

        // 新しいアクセストークンを発行
        const newAccessToken = jwt.sign(
            { receiverId: user.receiverId }, 
            JWT_SECRET, 
            { expiresIn: '15m' }
        );
        
        res.json({ accessToken: newAccessToken });
        log(`[refresh-token] issued for receiverId=${user.receiverId}`);
    });
});


// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
    console.log(`📡 VAPID public key: ${vapidKeys.publicKey}`);
});
