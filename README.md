# EdgeKintai

Cloudflare Workers + D1 で完結する、多ユーザー対応の勤怠管理システム。  
Free プランだけで動作し、R2 や外部データベースは不要。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/EdgeKintai)

---

## スクリーンショット

| ログイン | 今日の打刻 |
|:---:|:---:|
| ![ログイン](docs/screenshots/01_login.png) | ![今日の打刻](docs/screenshots/02_today.png) |
| **勤務カレンダー** | **月次集計・日別明細** |
| ![勤務カレンダー](docs/screenshots/03_calendar.png) | ![月次集計](docs/screenshots/04_summary.png) |
| **個人設定・通勤設定** | **管理画面・月次概要** |
| ![個人設定](docs/screenshots/05_settings.png) | ![管理画面](docs/screenshots/06_admin.png) |

---

## 主な機能

- **勤怠記録と勤務区分**: 出社・在宅・有給休暇・休日・欠勤の記録と管理
- **祝日・カレンダー自動判定**: 内閣府の祝日 CSV を週次取得・キャッシュし、国民の祝日アイコンと名称を自動表示
- **リアルタイム経過時間**: 出勤打刻からの経過時間を毎秒更新。休憩時間を差し引いた実働時間は退勤打刻の時点で確定します
- **所定日数＆未入力アラート**: 当月の所定勤務日数の自動算出、過去の未打刻・未退勤を専用カラーで警告
- **モバイル＆レスポンシブ最適化**: スマートフォン等の狭小画面でも崩れない TODAY ヘッダーと 7 列カレンダー表示
- **通勤費・経路スナップショット**: 出発地・到着地・交通手段・片道運賃・往復/片道の個別設定と過去記録の不変保持
- **ブラウザ内 Excel 生成**: 出勤簿・月次集計・交通費明細の 3 シート構成 Excel をクライアント側で高速生成
- **A4 印刷・サマリー共有**: A4 1 枚に収まる印刷レイアウト、Slack / Teams 向けのワンクリックサマリーコピー
- **堅牢なセキュリティ**: PBKDF2-SHA-256 パスワードハッシュ、セッションダイジェスト管理、レートリミット、CSRF 防御
- **PWA 対応**: ホーム画面への追加、iOS セーフエリア対応、ダーク／ライトテーマ切り替え

---

## デプロイ

### 方法 A：ワンクリックデプロイ

ページ上部のボタンをクリックし、途中で `SETUP_TOKEN` を入力してください：

```bash
openssl rand -hex 32
```

この値はコードや Issue には書かず、Cloudflare の暗号化 Secret としてのみ保存してください。

### 方法 B：ローカルデプロイ

Node.js 24.11+ が必要です。

```bash
npm ci
npm run deploy:cf
```

`deploy:cf` は verify → Wrangler ログイン確認 → D1 作成 → スキーマ適用 → `SETUP_TOKEN` 生成 → デプロイ を順に実行します。同じ D1 に対する再実行は安全です。

### Workers Builds の手動設定

| 設定 | 値 |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Build variable | `NODE_VERSION=24.11.0` |

初回ビルド前に `database_id` が全ゼロでないことと、`SETUP_TOKEN` が Secret に設定されていることを確認してください。

---

## ローカル開発

```bash
npm ci
cp .dev.vars.example .dev.vars   # SETUP_TOKEN を openssl rand -hex 32 で生成して記入
npm run db:migrate:local
npm run dev
# http://localhost:8787 を開き、Setup Token で初期管理者を作成
```

| コマンド | 説明 |
| :--- | :--- |
| `npm run dev` | ローカル開発サーバーを起動 |
| `npm run verify` | 型チェック + テスト + デプロイ設定チェック |
| `npm run deploy:dry-run` | `wrangler deploy` のドライラン |

---

## 設定

`wrangler.jsonc` の環境変数：

| 変数 | デフォルト | 説明 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 休憩時間（分） |
| `DEFAULT_ONE_WAY_FARE` | `210` | 片道交通費（円） |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` or `round_trip` |
| `DEFAULT_CLOCK_IN` | `10:00` | 出勤時刻の初期値 |
| `DEFAULT_CLOCK_OUT` | `19:00` | 退勤時刻の初期値 |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 月次残業アラートの閾値（時間） |
| `SESSION_TTL_SECONDS` | `604800` | セッション有効期間（秒、デフォルト 7 日） |
| `HEALTH_PROBE_ALLOWED_ORIGINS` | 空 | `/health` をブラウザから読み取れる Origin（カンマ区切り） |

ユーザーごとの設定が優先されます。日ごとの勤務・時刻・通勤経路・交通費は勤務カレンダーから個別に変更できます。

---

## プロジェクト構成

```
├── src/                  # Worker (Hono API)
│   ├── index.ts          # エントリーポイント・Cron ハンドラ
│   ├── routes/           # API ルート (auth, attendance, admin, export)
│   ├── middleware/        # 認証・管理者ガード
│   └── utils/            # パスワード, 祝日, バリデーション等
├── public/               # Static Assets（Worker を経由しない）
│   ├── index.html        # SPA
│   ├── app.js            # フロントエンドロジック
│   ├── excel.js          # ブラウザ内 Excel 生成（遅延読み込み）
│   └── styles.css
├── migrations/
│   └── 0001_schema.sql   # D1 スキーマ（単一ファイル）
├── scripts/              # デプロイヘルパー・テストスクリプト
├── test/                 # Vitest テスト
├── wrangler.jsonc        # Workers 設定
└── package.json
```

`wrangler.jsonc` の `run_worker_first: ["/api/*", "/health"]` により、API と公開死活監視だけが Worker を通過します。それ以外は Static Assets が直接返すので、Workers Free の動的リクエスト枠を節約できます。

### ヘルスチェック

| エンドポイント | 認証 | 用途 |
|---|---|---|
| `GET /health` | 不要 | Worker の liveness。D1 にアクセスせず、`HEALTH_PROBE_ALLOWED_ORIGINS` と完全一致する Origin だけがブラウザから読み取り可能 |
| `GET /api/health/ready` | 必要 | D1 を含む readiness |

---

## 注意事項

- **Free プラン適合**: Static Assets は無料・無制限。`/api/*` と `/health` が Workers の 10 万リクエスト／日・CPU 10ms／回の対象です。D1 Free は 500MB／DB、読み取り 500 万行／日、書き込み 10 万行／日。
- **セキュリティ**: Cookie は `HttpOnly; Secure; SameSite=Strict`。セッション token は SHA-256 ダイジェストのみ D1 に保存し、パスワード変更時は旧セッションを無効化します。
- **プライバシー**: R2 は使用しません。氏名・駅名・勤務記録は D1 と、利用者が端末へダウンロードした Excel にのみ保存されます。
- **バックアップ**: D1 Free は 7 日間の Time Travel がありますが、会社提出用データは別途バックアップを推奨します。

---

## License

[MIT](./LICENSE)
