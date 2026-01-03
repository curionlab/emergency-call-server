<div align="center">

[日本語](README.md) | [English](README_EN.md)

</div>

# 緊急コールシステム（バックエンド / Emergency Call Server）

> このリポジトリは「iPhone（SafariのPWA）へ Web Push 通知を送るためのサーバ」です。  
> フロントエンド（PWA）とセットで使うことを前提にしています： https://github.com/curionlab/emergency-call-client

***

## できること（このサーバの役割）

- 受信者（receiver）の **Push購読情報（PushSubscription）を保存** します。
- 発信者（sender）がAPIを叩くと、受信者へ **Web Push通知を送信** します。
- 認証コード（auth code）で「このIDの受信者登録を許可する」運用ができます。
- 購読情報の更新（subscriptionが変更されたとき）に対応します。

この仕組みは「テレビ会議/通話」だけでなく、**AIエージェントや監視ジョブがイベント発生時にユーザーへ通知する**用途にも転用できます（通知ペイロードの `title/body/url` を変えるだけ）。

***

## 想定する使い方（メイン）

このシステムは、次の2リポジトリを同時に使う前提です。

- **フロントエンド（PWA）**: emergency-call-client  
  https://github.com/curionlab/emergency-call-client
- **バックエンド（通知API）**: emergency-call-server（このリポジトリ）

**基本フロー**（運用イメージ）:
1. 発信者がサーバで「認証コード」を発行する（有効期限30分）。
2. 受信者がPWAを開き、Push通知を許可し、受信者ID＋認証コードで「登録」する（Push購読がサーバに保存される）。
3. 発信者（またはAIエージェント）が `/send-notification` を叩くと、受信者のiPhoneに通知が届く。
4. 受信者が通知をタップすると、PWAが開き（または誘導され）、`url/sessionId/senderId` などを使って次の画面へ遷移する（これはクライアント側実装）。

***

## 先に知っておくべき課題（特に「ローカルだけで通知したい」人向け）

### 1) Web Pushは「ローカルだけ」で完結しない
Web Push通知は、サーバ→端末へ直接送るのではなく、ブラウザ/OSのPushサービス（Apple等）を経由して配送されます。  
そのため「ローカルPCでサーバを立てて、同じLAN内のiPhoneにだけ通知したい」と考えると、次が課題になります。

- iPhoneが外出先（モバイル回線）にいると、LAN内サーバへ到達できません。
- 自宅サーバでやる場合、インターネット公開（ポート開放/固定URL/HTTPS）が必要になります。
- **HTTPS必須**（PWA + Push の前提）なので、証明書の用意（例: Cloudflare/Let's Encrypt）が必要です。

### 2) 購読（subscription）は永続ではない
Push購読情報は、OS/ブラウザ都合で更新・失効することがあります。  
運用としては「失効時に再登録させる導線」や「購読更新への追従（pushsubscriptionchange）」が重要です（これは主にフロント側/Service Workerの責務）。

***

## セットアップ（ローカル）

### 1) インストール & 起動
```bash
npm install
npm start
```
`PORT` を指定しない場合は 3000 で起動します。

***

## 環境変数（重要）

このサーバは環境変数で動作を設定します。

最低限（Push送信に必要）:
- `PORT`: サーバーポート（デフォルト: 3000）
- `VAPID_PUBLIC_KEY`: VAPID公開鍵（Push送信用）
- `VAPID_PRIVATE_KEY`: VAPID秘密鍵（Push送信用）
- `CLIENT_URL`: フロントエンドURL（通知クリックで遷移させたい起点URLなどに使用）

運用向け（現行実装では推奨）:
- `LOGIN_PASSWORD`: 発信者ログイン用パスワード（未設定なら `default-password`）
- `JWT_SECRET`: 発信者トークンの署名鍵（未設定なら `default-jwt-secret-key`）
- `REFRESH_TOKEN_SECRET`: リフレッシュトークン用署名鍵（未設定なら `default-refresh-secret`）
- `VAPID_CONTACT_EMAIL`: VAPIDの連絡先メール（未設定なら `emergency@example.com`）

> **注意**: `*_SECRET` や `VAPID_PRIVATE_KEY` をデフォルトのまま運用すると、安全ではありません（必ず本番では差し替えてください）。

***

## API（概要）

> 詳細は `server.js` を参照してください（ここでは「何ができるか」を優先して説明します）。

### ヘルスチェック
- **`GET /`**  
  ヘルスチェック（ステータス・バージョン・タイムスタンプを返却）。

- **`GET /health`**  
  ヘルスチェック（簡易：`{ status: "ok" }` を返却）。

### VAPID公開鍵取得
- **`GET /vapid-public-key`**  
  クライアントがPush購読に必要なVAPID公開鍵を取得します。

### 認証コード発行
- **`POST /generate-auth-code`**  
  受信者IDに対する認証コードを発行します。  
  **有効期限**: 30分

  ```json
  // リクエスト
  { "receiverId": "user123" }
  
  // レスポンス
  { "success": true, "code": "123456", "expiresIn": "30 minutes" }
  ```

### 受信者登録
- **`POST /register`**  
  受信者ID・認証コード・PushSubscription を受け取り、受信者として登録します。  
  成功すると以下のトークンが発行されます：
  - **アクセストークン**: 有効期限 15分
  - **リフレッシュトークン**: 有効期限 30日

  ```json
  // リクエスト
  {
    "receiverId": "user123",
    "authCode": "123456",
    "subscription": { "endpoint": "...", "keys": {...} }
  }
  
  // レスポンス
  {
    "success": true,
    "accessToken": "...",
    "refreshToken": "...",
    "message": "登録成功"
  }
  ```

### 購読情報更新
- **`POST /update-subscription`**  
  受信者の購読情報（PushSubscription）が変更されたときに使用します。  
  アクセストークン（またはリフレッシュトークン）で認証が必要です。

  ```json
  // リクエスト（Authorizationヘッダーにトークン）
  {
    "receiverId": "user123",
    "subscription": { "endpoint": "...", "keys": {...} }
  }
  
  // レスポンス
  { "success": true, "message": "購読情報を更新しました" }
  ```

### 発信者ログイン
- **`POST /login`**  
  発信者がパスワードでログインし、通知送信用トークンを取得します。  
  **有効期限**: 1時間

  ```json
  // リクエスト
  { "password": "your-password" }
  
  // レスポンス
  { "success": true, "token": "..." }
  ```

### 通知送信
- **`POST /send-notification`**  
  発信者トークン（Authorizationヘッダー）を使って、指定した受信者へ通知を送ります。

  ```json
  // リクエスト（Authorizationヘッダーに発信者トークン）
  {
    "receiverId": "user123",
    "sessionId": "session-456",
    "senderId": "sender-789",
    "title": "緊急コール",
    "body": "通話リクエストが届いています"
  }
  
  // レスポンス
  { "success": true, "message": "通知を送信しました", "sessionId": "session-456" }
  ```

### トークン更新
- **`POST /refresh-token`**  
  リフレッシュトークンを使って新しいアクセストークンを取得します。  
  新しいアクセストークンの有効期限: 15分

  ```json
  // リクエスト
  { "token": "refresh-token..." }
  
  // レスポンス
  { "accessToken": "new-access-token..." }
  ```

### デバッグ用
- **`GET /status`**  
  登録状況を確認します（認証コード数・登録受信者数など）。

***

## トークン・コードの有効期限まとめ

| 項目 | 有効期限 | 発行API | 用途 |
|------|---------|---------|------|
| 認証コード | 30分 | `/generate-auth-code` | 受信者登録時の認証 |
| 発信者トークン | 1時間 | `/login` | 通知送信の認証 |
| アクセストークン | 15分 | `/register`, `/refresh-token` | 購読更新などの認証 |
| リフレッシュトークン | 30日 | `/register` | アクセストークンの更新 |

***

## AIエージェント運用の考え方（おすすめ構成）

AIエージェント（監視、ワークフロー、LLMエージェント等）が「イベントを検知→通知」する場合、次の分離がおすすめです。

- **AIエージェント**：外部API・LLM・DBなどを使って判断し、最後にこのサーバの `/send-notification` を叩く  
- **このサーバ**：Push購読管理・通知送信に集中（責務を小さく保つ）

こうすると、AIエージェント側の実装を差し替えても「通知先の維持」はこのサーバが担当でき、運用がシンプルになります。

### AIエージェントからの通知送信例（curl）

```bash
# 1. ログイン
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'
# → { "success": true, "token": "eyJhbGc..." }

# 2. 通知送信
curl -X POST http://localhost:3000/send-notification \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGc..." \
  -d '{
    "receiverId": "user123",
    "sessionId": "session-456",
    "senderId": "agent-ai",
    "title": "重要なアラート",
    "body": "異常を検知しました"
  }'
```

***

## データ保存について（現状）
現行実装は `data.json` に登録情報を保存します（環境によってはファイルが存在しなければ初期データとして扱います）。

- Render/コンテナ環境などでは、ディスクが揮発する（デプロイで消える）ケースがあるため、長期運用ではDB/KV等への移行を検討してください。
- Cloudflare Workersへ移植する場合、ファイル保存はできないためKV/D1等へ置き換えが必要になります。

***

## セキュリティ注意

- PushSubscriptionは「通知を送るための宛先情報」なので、漏洩すると第三者があなたのアプリになりすまして通知を送れる可能性があります（VAPIDやサーバ側制御で軽減はするがゼロにはならない）
- 発信者用トークン、VAPID秘密鍵、各種Secretは絶対に公開しない
- 受信者の"購読更新"はアクセストークン等で本人性を担保する

***

## トラブルシュート

- **iPhoneで通知が出ない**
  - Safariではなく「ホーム画面に追加したPWA」になっているか確認
  - 通知許可がONか

- **急に届かなくなった**
  - 購読失効の可能性。再登録が必要な場合があります
  - サーバ側で送信失敗ログ（410等）を確認

***

## ライセンス

このプロジェクトは MIT License のもとで公開されています。詳細は `LICENSE` を参照してください。
