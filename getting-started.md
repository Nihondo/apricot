# よくわかる apricot

apricot を初めて使う人のための入門ガイドです。「これは何？」から始めて、セットアップ、基本的な使い方、高度な活用までステップアップできます。

---

## 目次

1. [apricot とは？](#apricot-とは)
2. [セットアップ](#セットアップ)
3. [基本の使い方](#基本の使い方)
4. [もっと便利に使う](#もっと便利に使う)
5. [高度な使い方](#高度な使い方)
6. [トラブルシューティング](#トラブルシューティング)

---

## apricot とは？

### ひとことで言うと

**IRC にいつでも・どこからでもつながれる「中継サーバー」** です。

### もう少し詳しく

IRC（Internet Relay Chat）は昔から使われているチャットの仕組みですが、普通の IRC クライアントはアプリを閉じると接続が切れてしまいます。その間のメッセージは読めません。

apricot はこの問題を解決します。

```
あなた  ←→  apricot（常時接続）  ←→  IRC サーバー
```

apricot が IRC サーバーに**ずっとつなぎっぱなし**にしてくれるので、あなたは好きなタイミングで apricot にアクセスするだけ。ブラウザを閉じていた間のメッセージも読めます。

### 3 つのアクセス方法

| 方法 | 向いている人 |
|------|-------------|
| **ブラウザ（Web UI）** | IRC 初心者、手軽に使いたい人 |
| **IRC クライアント（WebSocket）** | WeeChat や irssi に慣れている人 |
| **REST API** | ボットや自動化スクリプトを作りたい人 |

### どこで動くの？

apricot は **Cloudflare Workers** というクラウドサービス上で動きます。サーバーを自分で管理する必要はありません。ローカルの開発環境でも動かせるので、まずは手元で試してみましょう。

---

## セットアップ

### 必要なもの

- **Node.js** 18 以上（[インストール方法](https://nodejs.org/)）
- **Git**（ソースコードをダウンロードするため）
- 接続したい **IRC サーバー** の情報（ホスト名・ポート番号）

### ステップ 1: ソースコードを取得する

```bash
git clone <リポジトリURL>
cd apricot
```

### ステップ 2: 依存パッケージをインストールする

```bash
cd workers
npm install
```

### ステップ 3: IRC サーバーの接続設定

`workers/wrangler.toml` の `[vars]` セクションを編集します。

```toml
[vars]
IRC_HOST = "irc.libera.chat"       # 接続先サーバー
IRC_PORT = "6667"                   # ポート番号
IRC_NICK = "mynick"                 # ニックネーム
IRC_USER = "mynick"                 # ユーザー名
IRC_REALNAME = "apricot IRC Proxy"  # 表示名
IRC_TLS = "false"                   # TLS を使うか
IRC_AUTOJOIN = "#general"           # 自動参加チャンネル
TIMEZONE_OFFSET = "9"               # タイムゾーン（JST なら 9）
```

> **日本語の IRC サーバーを使う場合**は `IRC_ENCODING = "iso-2022-jp"` を追加してください。

### ステップ 4: パスワードを設定する

`workers/.dev.vars` ファイルを作成して、以下を記述します（このファイルは `.gitignore` 済みなので Git に含まれません）。

```ini
API_KEY=好きなAPIキーを設定
CLIENT_PASSWORD=好きなパスワードを設定
```

- **API_KEY** — REST API を使うときの認証キー
- **CLIENT_PASSWORD** — ブラウザや IRC クライアントから接続するときのパスワード

> `CLIENT_PASSWORD` を設定しないとブラウザと IRC クライアントからの接続はできません（503 エラーになります）。

### ステップ 5: 起動する

```bash
npm run dev
```

`http://localhost:8787` でサーバーが起動します。

### ステップ 6: IRC サーバーに接続する

別のターミナルで以下を実行します。

```bash
curl -X POST http://localhost:8787/proxy/myproxy/api/connect \
  -H "Authorization: Bearer 好きなAPIキーを設定"
```

ここで `myproxy` の部分が**プロキシ ID** です（後で詳しく説明します）。

接続できたか確認するには:

```bash
curl http://localhost:8787/proxy/myproxy/api/status \
  -H "Authorization: Bearer 好きなAPIキーを設定"
```

`"connected": true` と返ってくれば成功です。

---

## 基本の使い方

### ブラウザで IRC を使う

一番簡単な方法です。ブラウザで以下の URL を開きましょう。

```
http://localhost:8787/proxy/myproxy/web/
```

パスワード入力画面が出たら、`.dev.vars` に設定した `CLIENT_PASSWORD` を入力します。

#### チャンネル一覧画面

ログインすると、参加中のチャンネルが一覧で表示されます。ここでできることは:

- チャンネルをクリックしてチャット画面を開く
- 新しいチャンネルに参加する
- ニックネームを変更する

#### チャット画面

チャンネルを選ぶと、メッセージの送受信ができます。

- メッセージ中の URL は自動でリンクになります
- 新しいメッセージが来ると自動で反映されます
- 接続が不安定になっても自動で再同期します

### IRC クライアントで使う

WeeChat や irssi などの IRC クライアントから WebSocket 経由で接続できます。

WeeChat の設定例:

```
/server add apricot localhost/8787 -ssl=false
/set irc.server.apricot.password "CLIENT_PASSWORDで設定した値"
/connect apricot
```

接続すると、apricot が参加しているチャンネルの状態が自動的に同期されます。

### API でメッセージを送る

外部スクリプトからメッセージを投稿する例:

```bash
curl -X POST http://localhost:8787/proxy/myproxy/api/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 好きなAPIキーを設定" \
  -d '{"channel": "#general", "message": "Hello!"}'
```

---

## もっと便利に使う

### Web UI の見た目をカスタマイズする

設定画面（`/proxy/myproxy/web/settings`）から、さまざまな表示設定を変更できます。

| 設定項目 | できること |
|----------|-----------|
| フォント・文字サイズ | 好みのフォントとサイズに変更 |
| 配色テーマ | 13 色のカラーピッカーで自由に配色。ライト/ダークのプリセットあり |
| 表示順 | 古い順か新しい順かを切り替え |
| URL プレビュー | リンクの画像やカードを本文下に常時表示するか選択 |
| 強調キーワード | 指定した語をハイライト表示 |
| 控えめ表示キーワード | 指定した語を含むメッセージを薄く表示 |
| 追加 CSS | チャンネル画面の見た目を CSS で微調整 |

設定はプロキシ ID ごとに保存されます。

### 複数人で使う

apricot は 1 つのデプロイを複数人で共有できます。URL の中の**プロキシ ID** を変えるだけです。

```
Alice → /proxy/alice/web/    ← プロキシ ID: alice
Bob   → /proxy/bob/web/      ← プロキシ ID: bob
```

各プロキシ ID は完全に独立しています。

- IRC 接続（nick はプロキシ ID から自動設定）
- チャンネル状態・メッセージログ
- Web UI の表示設定

> **注意**: `CLIENT_PASSWORD` はデプロイ全体で共通です。プロキシ ID ごとに別々のパスワードを設定することはできません。

### URL をシェアするとプレビューが付く

`POST /api/post` で `message` の代わりに `url` を指定すると、ページタイトルを自動取得して投稿します。
`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_BROWSER_RENDERING_API_TOKEN` を設定すると、動的なサイトでもレンダリング後のタイトルを優先して取得できます。

```bash
curl -X POST http://localhost:8787/proxy/myproxy/api/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"channel": "#general", "url": "https://example.com/article"}'
```

Web UI では、OGP 画像や Twitter カードのプレビューも表示されます。

---

## 高度な使い方

### Cloudflare にデプロイする

ローカルで動作確認ができたら、Cloudflare Workers にデプロイして本番運用しましょう。

```bash
# 1. Cloudflare にログイン
npx wrangler login

# 2. シークレットを設定
npx wrangler secret put API_KEY
npx wrangler secret put CLIENT_PASSWORD

# 3. 必要なら URL タイトル取得用のシークレットも設定
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_BROWSER_RENDERING_API_TOKEN

# 4. デプロイ
npm run deploy
```

デプロイ後の URL:

```
https://apricot.<your-subdomain>.workers.dev/proxy/myproxy/web/
```

### プロキシ ID ごとに nick や autojoin を変える

デフォルトではプロキシ ID がそのまま nick になりますが、API で個別に設定できます。

```bash
curl -X PUT http://localhost:8787/proxy/myproxy/api/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"nick": "my_custom_nick", "autojoin": ["#general", "#dev"]}'
```

この設定は次回接続時から有効になります。`nick: null` や `autojoin: []` で設定をクリアしてデフォルトに戻せます。

### REST API を活用する

apricot の API を使えば、IRC を他のシステムと連携できます。

#### よく使う API 一覧

| やりたいこと | メソッド | パス |
|-------------|---------|------|
| 接続する | `POST` | `/proxy/:id/api/connect` |
| 切断する | `POST` | `/proxy/:id/api/disconnect` |
| チャンネルに参加 | `POST` | `/proxy/:id/api/join` |
| チャンネルを離脱 | `POST` | `/proxy/:id/api/leave` |
| メッセージ投稿 | `POST` | `/proxy/:id/api/post` |
| nick 変更 | `POST` | `/proxy/:id/api/nick` |
| ログ取得 | `GET` | `/proxy/:id/api/logs/:channel` |
| 状態確認 | `GET` | `/proxy/:id/api/status` |
| 設定変更 | `PUT` | `/proxy/:id/api/config` |

すべての API に `Authorization: Bearer <API_KEY>` ヘッダーが必要です。

#### 活用例: 通知ボット

GitHub の Webhook を受け取って IRC に通知するスクリプトなど、API を使えば簡単に作れます。

```bash
# PR がマージされたら IRC に通知する例
curl -X POST https://your-apricot.workers.dev/proxy/bot/api/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"channel": "#dev", "message": "PR #42 がマージされました"}'
```

### 環境変数リファレンス

すべての設定項目の一覧です。

| 環境変数 | 必須 | デフォルト | 説明 |
|----------|:----:|-----------|------|
| `IRC_HOST` | ✅ | ─ | IRC サーバーホスト名 |
| `IRC_PORT` | ─ | `6667` | ポート（レンジ指定可: `6660-6669`） |
| `IRC_NICK` | ─ | `apricot` | nick のフォールバック値 |
| `IRC_USER` | ─ | `apricot` | ユーザー名 |
| `IRC_REALNAME` | ─ | `apricot IRC Proxy` | リアルネーム |
| `IRC_TLS` | ─ | `false` | TLS 接続の有効化 |
| `IRC_PASSWORD` | ─ | ─ | サーバーパスワード |
| `CLIENT_PASSWORD` | ─ | ─ | Web UI / WebSocket 用パスワード |
| `IRC_AUTO_CONNECT_ON_STARTUP` | ─ | `false` | DO 起動時に自動接続を開始。初回リクエストは接続完了を待たない |
| `IRC_AUTO_RECONNECT_ON_DISCONNECT` | ─ | `false` | 切断時に自動再接続 |
| `IRC_CONNECT_TIMEOUT_MS` | ─ | `10000` | TCP ソケット確立待ちタイムアウト（ミリ秒） |
| `IRC_REGISTRATION_TIMEOUT_MS` | ─ | `120000` | IRC の `001` welcome 待ちタイムアウト。登録前メッセージを受信している間は延長される無通信タイムアウト（ミリ秒） |
| `IRC_RECONNECT_BASE_DELAY_MS` | ─ | `5000` | 自動再接続バックオフの初期待機時間（ミリ秒） |
| `IRC_RECONNECT_MAX_DELAY_MS` | ─ | `60000` | 自動再接続バックオフの最大待機時間（ミリ秒） |
| `IRC_RECONNECT_JITTER_RATIO` | ─ | `0.2` | 自動再接続待機時間に加えるジッター比率 |
| `IRC_IDLE_PING_INTERVAL_MS` | ─ | `240000` | 受信が止まった際に能動 `PING` を送るまでのアイドル時間（ミリ秒） |
| `IRC_PING_TIMEOUT_MS` | ─ | `90000` | 能動 `PING` 後の応答待ち時間（ミリ秒） |
| `IRC_AUTOJOIN` | ─ | ─ | 自動参加チャンネル（カンマ区切り） |
| `IRC_ENCODING` | ─ | `utf-8` | 文字コード |
| `ENABLE_REMOTE_URL_PREVIEW` | ─ | `false` | URL 自動プレビュー取得の総合スイッチ（受信・自分の投稿に適用） |
| `KEEPALIVE_INTERVAL` | ─ | `60` | キープアライブ間隔（秒） |
| `TIMEZONE_OFFSET` | ─ | `9` | タイムゾーンオフセット |
| `WEB_LOG_MAX_LINES` | ─ | `200` | ログ保持件数 |
| `API_KEY` | ✅ | ─ | API 認証キー |
| `CLOUDFLARE_ACCOUNT_ID` | ─ | ─ | URL 投稿時に Browser Rendering を使う Cloudflare アカウント ID |
| `CLOUDFLARE_BROWSER_RENDERING_API_TOKEN` | ─ | ─ | URL 投稿時に Browser Rendering を使う API トークン |

---

## トラブルシューティング

### 503 エラーが出る

- **Web UI / WebSocket** → `CLIENT_PASSWORD` が未設定です。`.dev.vars` に設定してください。
- **REST API** → `API_KEY` が未設定です。`.dev.vars` に設定してください。

### IRC サーバーに接続できない

1. `IRC_HOST` と `IRC_PORT` が正しいか確認
2. ローカル環境の場合、IRC サーバーが localhost からの接続を許可しているか確認
3. `api/status` で接続状態を確認

```bash
curl http://localhost:8787/proxy/myproxy/api/status \
  -H "Authorization: Bearer your-api-key"
```

### 日本語が文字化けする

`IRC_ENCODING` を IRC サーバーに合わせて設定してください。日本語サーバーでは `iso-2022-jp` が一般的です。

```toml
IRC_ENCODING = "iso-2022-jp"
```

### メッセージが消えた

apricot はチャンネルごとに最大 200 件のメッセージを保持します（`WEB_LOG_MAX_LINES` で変更可）。古いメッセージは順次削除されます。

### Durable Object が再起動した

Cloudflare のデプロイやランタイム更新時に Durable Object が再生成されることがあります。`IRC_AUTO_RECONNECT_ON_DISCONNECT = "true"` を設定しておくと、自動的に再接続されます。`IRC_AUTO_CONNECT_ON_STARTUP = "true"` の場合も、初回リクエストは接続完了を待たずに返り、裏で接続が進みます。
