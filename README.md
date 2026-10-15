# yt-post

YouTube コミュニティポストを、Discord でリッチな埋め込みカードとして表示する Cloudflare Worker。

Discord は YouTube の動画/Shorts リンクを標準で綺麗に埋め込みますが、**コミュニティポスト（`youtube.com/post/...`）はただの URL にしかなりません**。この Worker は「`youtube.com` をこの Worker のホストに置き換える」だけで、投稿者・本文・統計・画像・動画・投票/クイズ付きのカードを出します。Bot には Open Graph / activity+json を返し、実ブラウザは YouTube へ自動リダイレクトします。

FxEmbed / FixTweet に着想を得ています。

## できること

- コミュニティポストの **Discord リッチカード**（activity+json + Mastodon 互換 API）
- **GIF 投稿が Discord でアニメーション再生**（`/g/` プロキシで `image/gif` を明示配信）
- **動画共有ポスト**：サムネイル＋動画タイトルのリンク
- **投票**・**クイズ**（クイズはネタバレ防止で正解・解説を非表示）
- 複数画像・単一画像（fife の `-rwa` を剥がして GIF ソース化）
- oEmbed

## エンドポイント

| メソッド/パス | 内容 |
| --- | --- |
| `GET /post/<postId>` | OG タグ付き HTML（bot向け）。ブラウザは JS で YouTube へ |
| `GET /?url=<youtube_post_url>` | 同上（後方互換） |
| `GET /?url=<url>&format=json` | 生データ JSON |
| `GET /users/<handle>/statuses/<id>` | activity+json（Discord が辿る） |
| `GET /api/v1/statuses/<id>` | Mastodon 互換ステータス JSON |
| `GET /api/v1/instance` | Mastodon 互換インスタンス JSON |
| `GET /oembed` | oEmbed JSON |
| `GET /g/<hash>/<size>.gif` | 画像/GIF プロキシ（`image/gif`） |
| `GET /v/<hash>/<size>.mp4` | 動画プロキシ（H.264 MP4） |
| `GET /internal/favicon<size>.png` | サイトアイコン用プロキシ |
| `GET /` | プレーンテキストの使い方（`?lang=en` で英語） |

### クエリパラメータ

- `format=json` — 生データを JSON で返す（省略時は OG HTML）
- `titles=0` — 本文中リンクのタイトル取得をスキップ（高速）
- `comments=0` — コメント数の取得をスキップ（追加リクエストを省略、高速）
- `size=<px>` — 画像サイズ指定（例: `size=1205`）
- `activity=0` — activity+json リンクを出さない（Discord での切り分け用）
- `lang=en` — `/` のドキュメントを英語に

## 使い方

```
https://www.youtube.com/post/Ugkx...
→ https://ytp.drks.f5.si/post/Ugkx...
```

`youtube.com/post/...` のホストを `ytp.drks.f5.si` に置き換えるだけです。

Discord に貼ると、投稿者アイコン・本文・リアクション数・画像（GIFはアニメ）・動画リンク・投票/クイズを含むカードが出ます。

## デプロイ

```sh
npm install
npx wrangler publish
```

カスタムドメインで配信する場合は `wrangler.toml` の `routes`（コメントアウト済みの例）を有効化してください。

## 仕組み

- Cloudflare Worker（`worker.js` 1ファイル、依存ゼロ）
- ポストの `ytInitialData` を解析（`backstagePostRenderer`）
- 添付は `backstageAttachment` から取得（画像 / 複数画像 / 動画共有 / 投票 / クイズ）
- fife（`yt3.ggpht.com`）の形式サフィックスを正規化（`-rwa` のアニメWebPは Discord で再生できないため剥がす）
- Discord 向け activity+json は Discordbot UA のときだけ出力（本家 FxEmbed と同挙動）
- Worker のバージョンはエッジキャッシュキーの一部なので、再デプロイで古い応答は配信されない

## ライセンス

CC0 1.0 Universal（`LICENSE`）または WTFPL 2.0（`LICENSE-WTFPL`）のデュアルライセンス。どちらでも好きな方を選べます。実質的にパブリックドメインに提供します。

## 謝辞

- [FxEmbed](https://github.com/FxEmbed/FxEmbed) / FixTweet — activity+json によるリッチカードの仕組み
