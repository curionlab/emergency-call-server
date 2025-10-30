const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
// --- CORS設定を強化 ---
const corsOptions = {
    origin: process.env.CLIENT_URL, // あなたのクライアントのURLのみを許可
    methods: ['GET', 'POST'], // 許可するHTTPメソッド
    allowedHeaders: ['Content-Type', 'Authorization'], // 許可するリクエストヘッダー
    optionsSuccessStatus: 200 // プリフライトリクエストに200を返す
};
app.use(cors(corsOptions));

// --- 設定値 (環境変数から取得) ---
const DATA_FILE = path.join(__dirname, 'data.json');
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'default-password'; // 発信者ログイン用パスワード
const JWT_SECRET = process.env.JWT_SECRET || 'default-jwt-secret-key';   // トークン署名用の秘密鍵
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'default-refresh-secret'; // リフレッシュトークン用の秘密鍵


const raw = process.env.VAPID_CONTACT_EMAIL?.trim();
const VAPID_CONTACT_EMAIL = raw ? `mailto:${raw}` : 'mailto:emergency@example.com';

// VAPID設定（環境変数から取得、なければデフォルト）
const vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY || '__REDACTED_VAPID_PUBLIC_KEY__',
    privateKey: process.env.VAPID_PRIVATE_KEY || '__REDACTED_VAPID_PRIVATE_KEY__'
};

webpush.setVapidDetails(
    VAPID_CONTACT_EMAIL,
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

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

// --- 新しいエンドポイント: /login ---
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === LOGIN_PASSWORD) {
        // ログイン成功時、1時間有効な一時トークンを生成
        const token = jwt.sign({ authorized: true }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ success: true, token: token });
        log('発信者のログイン成功、トークンを発行しました。');
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
        log('発信者のログイン失敗: パスワードが不正です。', 'error');
    }
});


// --- トークン検証ミドルウェア ---
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>" 形式

    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, error: 'Forbidden: Invalid token' });
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
                error: '必須パラメータが不足しています'
            });
        }
        
        // データ読み込み
        const data = await loadData();
        
        // 受信者の購読情報取得
        const registration = data.registrations[receiverId];
        
        if (!registration) {
            return res.status(404).json({
                success: false,
                error: '受信者が登録されていません'
            });
        }
        
        // 通知ペイロード作成
        const payload = JSON.stringify({
            title: title || '🚨 緊急コール',
            body: body || '緊急通話が開始されました',
            sessionId: sessionId,
            senderId: senderId,
            url: process.env.CLIENT_URL || 'https://your-client-url.com',
            timestamp: Date.now()
        });
        
        // プッシュ通知送信
        await webpush.sendNotification(registration.subscription, payload);
        
        console.log(`[通知送信成功] ${receiverId} (セッション: ${sessionId})`);
        
        res.json({
            success: true,
            message: '通知を送信しました',
            sessionId: sessionId
        });
        
    } catch (error) {
        console.error('通知送信エラー:', error);
        
        // 購読が無効な場合は削除
        if (error.statusCode === 410) {
            const data = await loadData();
            delete data.registrations[req.body.receiverId];
            await saveData(data);
            console.log(`[購読削除] ${req.body.receiverId}`);
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
                error: 'receiverIdが必要です'
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
        
        console.log(`[認証コード生成] ${receiverId} -> ${code}`);
        
        res.json({
            success: true,
            code: code,
            expiresIn: '30分'
        });
        
    } catch (error) {
        console.error('認証コード生成エラー:', error);
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
                error: '必須パラメータが不足しています'
            });
        }
        
        // データ読み込み
        const data = await loadData();
        
        // 認証コード検証
        const storedAuth = data.authCodes[receiverId];
        
        if (!storedAuth) {
            return res.status(401).json({
                success: false,
                error: '認証コードが見つかりません'
            });
        }
        
        if (storedAuth.code !== authCode) {
            return res.status(401).json({
                success: false,
                error: '認証コードが正しくありません'
            });
        }
        
        if (storedAuth.expires < Date.now()) {
            // 期限切れの認証コードを削除
            delete data.authCodes[receiverId];
            await saveData(data);
            
            return res.status(401).json({
                success: false,
                error: '認証コードの有効期限が切れています'
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
        
        console.log(`[受信者登録成功] ${receiverId}`);

        // アクセストークンとリフレッシュトークンを生成
        const accessToken = jwt.sign({ receiverId: receiverId }, JWT_SECRET, { expiresIn: '15m' });
        const refreshToken = jwt.sign({ receiverId: receiverId }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });

        res.json({ 
            success: true, 
            accessToken, 
            refreshToken,
            message: '登録が完了しました'
         }); // 2つのトークンを返す
        
    } catch (error) {
        console.error('受信者登録エラー:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// --- 新しいエンドポイント: /refresh-token を追加 ---
// (これは /register や /login の後に追加してください)
app.post('/refresh-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.sendStatus(401);

    jwt.verify(token, REFRESH_TOKEN_SECRET, (err, user) => {
        if (err) {
            log('無効なリフレッシュトークンが使用されました。', 'warning');
            return res.sendStatus(403); // Forbidden
        }
        // 新しいアクセストークンを発行
        const newAccessToken = jwt.sign({ receiverId: user.receiverId }, JWT_SECRET, { expiresIn: '15m' });
        res.json({ accessToken: newAccessToken });
        log(`トークンをリフレッシュしました: ${user.receiverId}`);
    });
});


// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 緊急コールサーバー起動: http://localhost:${PORT}`);
    console.log(`📡 VAPID公開鍵: ${vapidKeys.publicKey}`);
});

// --- ログ関数 (簡略化のため、既存のものをそのまま使用) ---
function log(msg, type = 'info') { console.log(`[${type}] ${msg}`); }