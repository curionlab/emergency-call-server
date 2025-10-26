# 緊急コールシステム - バックエンド

## セットアップ

```
npm install
npm start
```


## 環境変数

- `PORT`: サーバーポート（デフォルト: 3000）
- `VAPID_PUBLIC_KEY`: VAPID公開鍵
- `VAPID_PRIVATE_KEY`: VAPID秘密鍵
- `CLIENT_URL`: フロントエンドURL

## API エンドポイント

- `GET /` - ヘルスチェック
- `POST /generate-auth-code` - 認証コード生成
- `POST /register` - 受信者登録
- `POST /send-notification` - プッシュ通知送信
- `GET /status` - 登録状況確認
