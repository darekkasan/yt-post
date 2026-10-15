/**
 * YouTube コミュニティポスト抽出 Cloudflare Worker
 *
 * GET /post/<postId>                          → OG タグ付きHTML（bot向け）+ 実ブラウザはJSで自動リダイレクト
 * GET /?url=<youtube_post_url>                → 同上（後方互換）
 * GET /?url=<youtube_post_url>&format=json    → 生JSON
 *
 * クエリパラメータ:
 *   url     : YouTube ポスト URL（path形式を使わない場合）
 *   format  : "json" で生データJSONを返す。省略時は常にOG HTML
 *   titles  : "0" でリンクタイトル取得をスキップ（デフォルト: 取得する）
 *   comments: "0" でコメント数取得をスキップ（デフォルト: 取得する）
 *   size    : 画像サイズ px 指定（例: 1205）。省略時は最大サイズ
 */

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ─── HTML 取得 ────────────────────────────────────────────────────────────────

// Set-Cookie を後続の Innertube API 呼び出し（コメント数取得）で使い回すため、
// レスポンスヘッダーから Cookie ヘッダー用の文字列も一緒に返す。
async function fetchHtml(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Cloudflare Workers では複数の Set-Cookie を getAll で取れる
  const setCookies =
    typeof res.headers.getAll === "function"
      ? res.headers.getAll("set-cookie")
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  const cookie = setCookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");

  return { html, cookie };
}

// ─── YouTube favicon の動的解決 ─────────────────────────────────────────────
// YouTubeのPNG favicon URLはビルドハッシュ入り
// (/s/desktop/{hash}/img/favicon_32x32.png)で、ハードコードすると
// ハッシュが変わるたびに壊れる。実際にYouTubeのページを取得すると
// <link rel="icon">タグに常に「今の」ハッシュ付きURLが載っているため、
// それを都度パースして使う。Cache APIで一定時間メモ化し、MISS時だけ
// 取り直す。
const FAVICON_CACHE_KEY = new Request("https://internal-cache.workers.dev/youtube-favicons");
const FAVICON_CACHE_TTL_SECONDS = 60 * 60 * 12; // 12時間

function extractFaviconMap(html) {
  const map = {};
  const linkTags = html.match(/<link[^>]+rel="(?:shortcut icon|icon)"[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const hrefMatch = tag.match(/href="([^"]+)"/);
    const sizesMatch = tag.match(/sizes="(\d+)x\d+"/);
    if (!hrefMatch) continue;
    const key = sizesMatch ? sizesMatch[1] : "ico";
    map[key] = hrefMatch[1];
  }
  return map;
}

async function getYoutubeFaviconMap() {
  try {
    const cached = await caches.default.match(FAVICON_CACHE_KEY);
    if (cached) return await cached.json();
  } catch {
    // キャッシュ読み取り失敗は無視して素通しで取り直す
  }

  try {
    const res = await fetch("https://www.youtube.com/", { headers: FETCH_HEADERS });
    if (!res.ok) return {};
    const html = await res.text();
    const map = extractFaviconMap(html);
    if (Object.keys(map).length) {
      const cacheResponse = new Response(JSON.stringify(map), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${FAVICON_CACHE_TTL_SECONDS}`,
        },
      });
      await caches.default.put(FAVICON_CACHE_KEY, cacheResponse).catch(() => {});
    }
    return map;
  } catch {
    return {};
  }
}



function parseInitialData(html) {
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ─── 再帰キー探索 ─────────────────────────────────────────────────────────────

function findAll(obj, key, results = []) {
  if (obj === null || typeof obj !== "object") return results;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, results);
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) results.push(v);
      findAll(v, key, results);
    }
  }
  return results;
}

// ─── run のリダイレクトURL取得 ────────────────────────────────────────────────

function resolveRunUrl(run) {
  return run?.navigationEndpoint?.urlEndpoint?.url ?? null;
}

// YouTubeの "https://www.youtube.com/redirect?event=...&redir_token=...&q=<実URL>"
// という追跡用ラッパーURLから、実際の展開先URL（qパラメータ）だけを取り出す。
// クリック時にYouTubeのredirectサーバーを経由させず、既に展開済みのURLを
// 直接hrefに使うことで、YouTube側の追跡（リファラー・クリックログ等）を回避する。
function resolveFinalUrl(redirectUrl) {
  try {
    const parsed = new URL(redirectUrl);
    return parsed.searchParams.get("q") ?? redirectUrl;
  } catch {
    return redirectUrl;
  }
}

// ─── リンク先タイトル取得 ─────────────────────────────────────────────────────

async function fetchPageTitle(redirectUrl) {
  try {
    const parsed = new URL(redirectUrl);
    const dest = parsed.searchParams.get("q") ?? redirectUrl;

    const res = await fetch(dest, { headers: FETCH_HEADERS });
    // 先頭 8KB だけ読む
    const reader = res.body.getReader();
    let chunk = "";
    while (chunk.length < 8192) {
      const { done, value } = await reader.read();
      chunk += new TextDecoder().decode(value ?? new Uint8Array());
      if (done) break;
    }
    reader.cancel();

    const m = chunk.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) {
      return m[1]
        .trim()
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
    }
    // title なし → プロトコル除去した実URL
    return dest.replace(/^https?:\/\//, "");
  } catch {
    // フェッチ失敗 → q= だけ取り出してプロトコル除去
    try {
      const dest = new URL(redirectUrl).searchParams.get("q") ?? redirectUrl;
      return dest.replace(/^https?:\/\//, "");
    } catch {
      return "";
    }
  }
}

// ─── 画像抽出 ─────────────────────────────────────────────────────────────────

function extractImages(html, excludeHashes = new Set()) {
  const rawUrls = [
    ...html.matchAll(/https:\/\/yt3\.ggpht\.com\/[A-Za-z0-9_\-]+(?:=[^\s"'<>\\]*)?/g),
  ].map((m) => m[0]);

  // Googleアカウントの円形アバター特有の修飾子（例: =s200-c-k-c0x00ffffff-no-rj）。
  // 投稿本文の添付写真ではなく、常にチャンネル/コメント投稿者のアイコンなので除外する。
  const isAvatarPattern = (u) => /-c-k-c0x[0-9a-fA-F]{8}-no-rj/.test(u);

  // チャンネルバナーのクロップ（-c- を含む）や ?days_since_epoch=... 付きは
  // 投稿添付ではなく、日替わりで失効する署名付きURLのため除外する。
  const isCropOrEphemeral = (u) => /-c-|\?days_since_epoch=/.test(u);

  const urls = rawUrls.filter((u) => !isAvatarPattern(u));
  const clean = urls.filter((u) => !isCropOrEphemeral(u));
  // 除外の結果1枚も残らない場合のみフォールバックとして全採用する
  // （画像ゼロよりはマシなため）。
  // sizes には -rwa 付きを含む原文URLをそのまま残す（除外しない）。
  const effective = clean.length ? clean : urls;

  const groups = new Map();
  for (const url of effective) {
    const base = url.match(/^(https:\/\/yt3\.ggpht\.com\/[A-Za-z0-9_\-]+)/)?.[1];
    if (!base) continue;
    const hash = base.split("/").pop();
    if (excludeHashes.has(hash)) continue; // 投票選択肢のサムネイルは除外
    if (!groups.has(base)) groups.set(base, new Set());
    groups.get(base).add(url);
  }

  const getSize = (u) => parseInt(u.match(/=s(\d+)/)?.[1] ?? "0", 10);

  // 埋め込みに使う largest だけ形式強制サフィックス（-rwa/-rw/-rh）を落とした
  // 素のURLにする。素のURLはソース形式そのまま（GIFソース→アニメーション
  // GIF）を返すことは実測済み。-rwa 付きはDiscordの埋め込みでアニメ再生
  // できないため largest には使わないが、sizes には原文のまま残す。
  const toPlainUrl = (u) => u.replace(/-(rwa|rw|rh)(?=\?|$)/, "");

  return [...groups.entries()].map(([base, urlSet]) => {
    const urls = [...urlSet];
    const sorted = [...urls].sort((a, b) => getSize(a) - getSize(b));
    const biggest = urls.reduce((a, b) => {
      const sa = getSize(a);
      const sb = getSize(b);
      if (sa !== sb) return sa >= sb ? a : b;
      // 同サイズ内では素の形式を優先
      const pa = /-(rwa|rw|rh)(?=\?|$)/.test(a) ? 1 : 0;
      const pb = /-(rwa|rw|rh)(?=\?|$)/.test(b) ? 1 : 0;
      return pa <= pb ? a : b;
    });
    const largest = toPlainUrl(biggest);
    return {
      base,
      hash: base.split("/").pop(),
      sizes: sorted,
      largest,
      largest_size: getSize(largest),
    };
  });
}

// YouTubeコミュニティポストの「動画の共有」添付。
// backstagePostRenderer.backstageAttachment.videoRenderer（またはその別形
// compactVideoRenderer）に格納される。既存の extractImages は yt3.ggpht.com の
// 投稿画像しか見ていないため、動画共有ポストは images:[] になり埋め込みに
// 何も出せない。別枠で取り出す。サムネイルは i.ytimg.com の静的JPEGで、
// 署名(sqp/rs)を落としても200で取得できるため、失効しないURLに正規化して使う。
function extractSharedVideo(p) {
  const att = p?.backstageAttachment ?? {};
  const v = att.videoRenderer ?? att.compactVideoRenderer;
  if (!v || !v.videoId) return null;
  const thumbs = v.thumbnail?.thumbnails ?? [];
  const best = thumbs.reduce(
    (a, b) => ((b.width ?? 0) > (a?.width ?? 0) ? b : a),
    null
  );
  const textOf = (node) =>
    node?.runs?.[0]?.text ?? node?.simpleText ?? "";
  const videoId = v.videoId;
  const thumbnail = best?.url
    ? best.url.replace(/\?.*$/, "")
    : `https://i.ytimg.com/vi/${videoId}/hq720.jpg`;
  return {
    video_id: videoId,
    title: textOf(v.title),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail,
    thumbnail_width: best?.width ?? null,
    thumbnail_height: best?.height ?? null,
    length: v.lengthText?.simpleText ?? "",
    views: v.viewCountText?.simpleText ?? "",
    owner: textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText),
    published: v.publishedTimeText?.simpleText ?? "",
  };
}

function buildUrl(base, size = null) {
  return size ? `${base}=s${size}-nd-v1` : base;
}

// 埋め込みに使う画像URL（largest）は形式強制サフィックス（-rwa/-rw/-rh）を
// 落とした素のURLを使う。素のURLはソース形式そのまま（GIFソース→
// アニメーションGIF）を返すことは実測済み。-rwa 付きのアニメーションWebPは
// Discordの埋め込みでアニメ再生できないため largest には使わない。
// ただし sizes 配列には -rwa 付きを含む原文URLをそのまま残す。
//
// GIF投稿のアニメーションMP4を取得するためのサフィックス。
// fife は GIF ソースに対して "=sXXX-rh" で H.264 MP4 を返す。
// Discord の og:video 埋め込みは MP4（H.264）のみ安定して再生でき、
// WebM は使えないため、動画埋め込みには必ずこちらを使う。
function withVideo(base, size) {
  return `${base}=s${size}-rh`;
}

// 埋め込み用MP4の公開URL。自前の /v/<hash>/<size>.mp4 経由にし、拡張子付きの
// 直接ファイルURLとしてDiscordに渡す（FxEmbedの .mp4 直リンクと同発想）。
// baseUrl が無い場合のみ fife の素URLをそのまま使う。
function videoUrlFor(img, size, baseUrl) {
  if (baseUrl && img.hash && Number.isFinite(size)) {
    return `${baseUrl}/v/${img.hash}/${size}.mp4`;
  }
  return withVideo(img.base, size);
}

// channel_url (例: "https://www.youtube.com/@handle") から @ハンドル部分だけ取り出す
function extractHandle(channelUrl) {
  const m = (channelUrl || "").match(/\/@([^/?]+)/);
  return m ? m[1] : null;
}

// ─── postId ⇄ 短い英数字ID 変換 ────────────────────────────────────────────
// これまで「数字のみ」が条件だと考えて10進数変換していたが、実際に確認できて
// いたのは「_ や - のような記号がダメ」ということだけで、英字が混ざっていても
// 良いという確証は無かった。base36（0-9 + a-z、記号を含まない）を使えば、
// 情報量あたりの文字数が10進数よりずっと少なく済む
// （192bitの本体を10進数で表すと約58〜59桁だが、base36なら約38〜39文字）。
// ローカルでベンチマーク済み: 1回あたり約0.01ms、正しさもラウンドトリップで検証済み。
//
// "Ugkx" という共通プレフィックスの除去（先頭1桁のフラグで管理）は
// 引き続き適用する。
const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const POST_ID_COMMON_PREFIX = "Ugkx";

function bigIntToBase36(n) {
  if (n === 0n) return "0";
  let r = "";
  const base = 36n;
  while (n > 0n) {
    r = BASE36_ALPHABET[Number(n % base)] + r;
    n /= base;
  }
  return r;
}

function base36ToBigInt(s) {
  let n = 0n;
  const base = 36n;
  for (const ch of s.toLowerCase()) {
    const idx = BASE36_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    n = n * base + BigInt(idx);
  }
  return n;
}

function postIdToNumeric(postId, gifProxy = false) {
  try {
    const hasPrefix = postId.startsWith(POST_ID_COMMON_PREFIX);
    const payload = hasPrefix
      ? postId.slice(POST_ID_COMMON_PREFIX.length)
      : postId;

    // base64url → バイト列 → 巨大整数 → base36文字列
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    // atobは長さが4の倍数でないbase64文字列を渡すと末尾を静かに
    // 切り捨てることがあるため、明示的に"="でパディングしてから渡す。
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    const byteLength = bin.length;
    let hex = "";
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    const n = hex ? BigInt("0x" + hex) : 0n;

    // BigIntは先頭が0x00のバイトを消してしまうため、バイト長を
    // 明示的に記録しておかないと復元時にゼロバイトを復元できない
    // （例: 先頭バイトがたまたま0x00の投稿で起きる。確率は低いが
    // 実際に起こりうるため、桁数を多少犠牲にしてでも正確性を優先する）。
    // 先頭1桁: フラグ。"1"=Ugkx接頭辞あり "2"=なし "3"=接頭辞あり+GIFプロキシ
    // "4"=接頭辞なし+GIFプロキシ。続く2桁: バイト長(base36、最大36^2=1296byteまで対応)。
    // GIFプロキシフラグ: Discordはactivity+jsonのURLを後から独立に取得するため、
    // クエリパラメータでは引き継げない。status ID 自体に埋め込む必要がある。
    const lengthTag = byteLength.toString(36).padStart(2, "0");
    if (lengthTag.length > 2) return null; // 想定外に長い場合は変換しない

    const flag = gifProxy ? (hasPrefix ? "3" : "4") : hasPrefix ? "1" : "2";
    return flag + lengthTag + bigIntToBase36(n);
  } catch {
    return null;
  }
}

function numericToPostId(numericStr) {
  try {
    if (numericStr.length < 4) return null;
    const flag = numericStr[0];
    if (!["1", "2", "3", "4"].includes(flag)) return null;
    const byteLength = parseInt(numericStr.slice(1, 3), 36);
    if (!Number.isFinite(byteLength) || byteLength < 0) return null;

    const n = base36ToBigInt(numericStr.slice(3));
    if (n === null || n < 0n) return null;

    // byteLength に合わせて先頭ゼロバイトを正しく復元する
    let bin;
    if (byteLength === 0) {
      bin = "";
    } else {
      let hex = n.toString(16);
      if (hex.length % 2 === 1) hex = "0" + hex;
      hex = hex.padStart(byteLength * 2, "0");
      if (hex.length / 2 !== byteLength) return null; // 万一ズレていたら壊れた変換とみなす
      bin = "";
      for (let i = 0; i < hex.length; i += 2) {
        bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
    }
    const payload = btoa(bin)
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    return flag === "1" || flag === "3"
      ? POST_ID_COMMON_PREFIX + payload
      : payload;
  } catch {
    return null;
  }
}

// ─── コメント数取得 ────────────────────────────────────────────────────────────
// コミュニティポストの初期HTMLにはコメント数が含まれておらず、YouTube内部の
// Innertube API (youtubei/v1/browse) へ継続トークン付きでリクエストして初めて
// コメント欄セクションのヘッダー(件数テキスト)が返ってくる。

function extractInnertubeAuth(html) {
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const contextMatch = html.match(
    /"INNERTUBE_CONTEXT":(\{.*?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/s
  );
  if (!apiKeyMatch || !contextMatch) return null;
  try {
    return { apiKey: apiKeyMatch[1], context: JSON.parse(contextMatch[1]) };
  } catch {
    return null;
  }
}

async function fetchCommentCount(data, html, cookie) {
  try {
    const auth = extractInnertubeAuth(html);
    if (!auth) return null;

    const token = findAll(data, "continuationCommand")[0]?.token;
    if (!token) return null;

    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${auth.apiKey}&prettyPrint=false`,
      {
        method: "POST",
        headers: {
          ...FETCH_HEADERS,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({ context: auth.context, continuation: token }),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();

    const header = findAll(json, "commentsHeaderRenderer")[0];
    const countText =
      header?.countText?.runs?.map((r) => r.text).join("") ??
      header?.countText?.simpleText ??
      null;
    if (!countText) return null;

    // "37 件のコメント" / "37 Comments" のような文字列から数字部分だけ取り出す
    const digits = countText.match(/[\d,]+/)?.[0];
    return digits ? digits.replace(/,/g, "") : countText;
  } catch {
    return null;
  }
}



// ─── 投票（poll）抽出 ──────────────────────────────────────────────────────

// 投稿データにUNIX時刻が含まれる場合のみISO 8601へ変換する。
// 時刻が取得できない投稿では、published の相対表記をフッターに使う。
function extractPublishedAt(post, html = "") {
  const unixCandidates = [
    post?.publishedTimestampUsec,
    post?.publishedTimeUsec,
    post?.timestampUsec,
    post?.publishedTimestamp,
  ];
  for (const value of unixCandidates) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    const milliseconds = number >= 1e14 ? number / 1000 : number >= 1e11 ? number : number * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 2005) {
      return date.toISOString();
    }
  }

  // コミュニティ投稿のHTMLにはJSON-LD/初期データとして正確なISO日時が入る。
  // 例: "datePublished":"2026-08-14T04:30:06.478359-07:00"
  const isoCandidates = [
    post?.publishDate,
    post?.postDetails?.publishDate,
    post?.postDetails?.discussionForumPosting?.datePublished,
    html.match(/"datePublished":"([^"\\]+)"/)?.[1],
    html.match(/"publishDate":"([^"\\]+)"/)?.[1],
  ];
  for (const value of isoCandidates) {
    if (typeof value !== "string" || !value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 2005) {
      return date.toISOString();
    }
  }
  return null;
}

function extractPoll(post) {
  const polls = findAll(post, "pollRenderer");
  if (!polls.length) return null;
  const poll = polls[0];

  const choices = (poll.choices ?? []).map((c) => {
    const text = c.text?.runs?.map((r) => r.text ?? "").join("") ?? "";
    const thumb = c.image?.thumbnails?.[0]?.url ?? null;
    return { text, image: thumb };
  });

  return {
    total_votes: poll.totalVotes?.simpleText ?? "",
    choices,
  };
}

// クイズ投稿の添付（quizRenderer）。質問文は本文側にあり、ここには選択肢と
// 正誤(isCorrect)・正解の解説(explanation)・回答数(totalVotes)が入る。
// 埋め込みではネタバレ防止のため isCorrect/explanation は一切出さず、
// 投票と同じく選択肢一覧だけを表示する。
function extractQuiz(post) {
  const quizzes = findAll(post, "quizRenderer");
  if (!quizzes.length) return null;
  const quiz = quizzes[0];

  const choices = (quiz.choices ?? []).map((c) => {
    const text = c.text?.runs?.map((r) => r.text ?? "").join("") ?? "";
    const thumb = c.image?.thumbnails?.[0]?.url ?? null;
    return { text, image: thumb };
  });

  return {
    total_votes: quiz.totalVotes?.simpleText ?? "",
    choices,
  };
}

// ポール選択肢のサムネイル画像ハッシュを集める（本文添付画像と区別するため）
function pollImageHashes(poll) {
  if (!poll) return new Set();
  const hashes = new Set();
  for (const c of poll.choices) {
    if (!c.image) continue;
    const m = c.image.match(/yt3\.ggpht\.com\/([A-Za-z0-9_\-]+)/);
    if (m) hashes.add(m[1]);
  }
  return hashes;
}

async function extractPost(html, fetchLinkTitles = true, fetchComments = true, cookie = null) {
  const data = parseInitialData(html);
  const posts = data ? findAll(data, "backstagePostRenderer") : [];
  if (!posts.length) return null;

  // コメント数取得(YouTube内部APIへの追加リクエスト)は、本文中リンクの
  // タイトル取得ループと互いに依存関係が無いため、ここで先に起動だけしておき、
  // 実際に結果が必要になるタイミング(returnの直前)でawaitする。
  // これにより両者が直列(合計時間)ではなく並行(遅い方の時間だけ)で
  // 完了するようになり、タイムアウトのリスクを減らせる。
  const commentCountPromise = fetchComments
    ? fetchCommentCount(data, html, cookie)
    : Promise.resolve(null);

  const p = posts[0];
  const textRuns = p.contentText?.runs ?? [];
  const textParts = [];
  const links = [];
  const seenLinks = new Set();

  for (const run of textRuns) {
    const redirectUrl = resolveRunUrl(run);
    const displayText = run.text ?? "";
    if (redirectUrl) {
      const finalUrl = resolveFinalUrl(redirectUrl);
      const title = fetchLinkTitles
        ? (await fetchPageTitle(redirectUrl)) || displayText
        : displayText;
      textParts.push(`[${title}](${finalUrl})`);
      if (!seenLinks.has(finalUrl)) {
        seenLinks.add(finalUrl);
        links.push(finalUrl);
      }
    } else {
      textParts.push(displayText);
    }
  }

  const text = textParts.join("").trim();
  const author = p.authorText?.runs?.[0]?.text ?? "";
  const channelUrl = decodeURIComponent(
    p.authorEndpoint?.browseEndpoint?.canonicalBaseUrl ?? ""
  );
  const published = p.publishedTimeText?.runs?.[0]?.text ?? "";
  const publishedAt = extractPublishedAt(p, html);
  const likes = p.voteCount?.simpleText ?? "";
  const postId = p.postId ?? "";
  const postUrl = postId ? `https://www.youtube.com/post/${postId}` : "";

  // チャンネルアバター（authorThumbnail.thumbnails は小さい順に並ぶので末尾が最大）。
  // YouTubeはこのURLを "//yt3.googleusercontent.com/..." のように
  // スキーム省略（protocol-relative）で返すことがあり、そのままだと
  // JSON経由（activity+jsonのaccount.avatar等）で渡した際に無効なURLとして
  // 扱われる恐れがあるため、常に https: を補って絶対URL化する。
  const avatarThumbs = p.authorThumbnail?.thumbnails ?? [];
  const rawAvatar = avatarThumbs.length
    ? avatarThumbs[avatarThumbs.length - 1].url
    : null;
  const avatar = rawAvatar
    ? (rawAvatar.startsWith("//") ? `https:${rawAvatar}` : rawAvatar)
    : null;

  const poll = extractPoll(p);
  const quiz = extractQuiz(p);
  const excludeHashes = new Set([
    ...pollImageHashes(poll),
    ...pollImageHashes(quiz),
  ]);
  const video = extractSharedVideo(p);

  // ここまでの処理と並行して走っていたコメント数取得の結果を待つ。
  // ここに来る頃には既に完了していることが多いため、実質待ち時間ゼロになる。
  const commentCount = await commentCountPromise;

  return {
    post_id: postId,
    author,
    channel_url: channelUrl,
    avatar,
    text,
    links,
    published,
    published_at: publishedAt,
    likes,
    comment_count: commentCount,
    post_url: postUrl,
    poll, // ポール投稿でなければ null
    quiz, // クイズ投稿でなければ null
    video, // 動画共有投稿でなければ null
    images: extractImages(html, excludeHashes),
  };
}

// ─── Discord 向け OG タグ HTML 生成 ───────────────────────────────────────────
// Discord は Discordbot UA で GET して HTML の OG/Twitter Card メタタグを読む

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 投稿本文の末尾に表示する反応・公開日時。
function buildEngagementText(post) {
  const parts = [];
  if (post.comment_count) parts.push(`💬 ${post.comment_count}`);
  if (post.likes) parts.push(`👍 ${post.likes}`);
  return parts.length ? parts.join("   ") : "";
}

// OG、oEmbed、ActivityPubで共通利用する投稿本文を組み立てる。
function buildPostBodyText(post) {
  let bodyText = post.text || "";
  if (post.poll) {
    const lines = post.poll.choices.map(
      (c, i) => `${i + 1}. ${c.text}`
    );
    bodyText += `\n\n📊 投票（${post.poll.total_votes || "?"}）\n${lines.join("\n")}`;
  }
  // クイズは正解・解説を出さず選択肢のみ（ネタバレ防止）。
  if (post.quiz) {
    const lines = post.quiz.choices.map(
      (c, i) => `${i + 1}. ${c.text}`
    );
    bodyText += `\n\n❓ クイズ（${post.quiz.total_votes || "?"}）\n${lines.join("\n")}`;
  }
  // 共有動画は本文にタイトル付きリンクとして追記する。
  // ハイパーリンク名（リンクテキスト）は動画タイトル。
  if (post.video) {
    const label = post.video.title || post.video.url;
    bodyText += `${bodyText ? "\n\n" : ""}▶ [${label}](${post.video.url})`;
  }
  // コメント数といいね数は別々に取得した実数を、そのまま本文末尾へ表示する。
  const engagementText = buildEngagementText(post);
  if (engagementText) bodyText += `${bodyText ? "\n\n" : ""}${engagementText}`;
  return bodyText;
}

// activity+jsonのcontentフィールド用に、本文中の "[表示テキスト](URL)" 形式の
// リンクを実際にクリック可能な <a href="URL">表示テキスト</a> へ変換する。
// Discordのcontentレンダラーは <a> タグを認識してリンクとして描画するため、
// 記号のまま渡すと単なる "[...](...)" という文字列にしか見えなくなる。
// リンク以外の地の文はエスケープしつつ、リンク部分だけHTMLとして組み立てる。
function bodyTextToHtml(bodyText) {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = "";
  let lastIndex = 0;
  let match;
  while ((match = linkPattern.exec(bodyText)) !== null) {
    result += escapeHtml(bodyText.slice(lastIndex, match.index));
    const [, label, href] = match;
    result += `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(bodyText.slice(lastIndex));
  return result.replace(/\n/g, "<br>");
}

function buildOgHtml(post, size = null, baseUrl = "", isDiscordBot = false, activityEnabled = true) {
  const handle = extractHandle(post.channel_url);
  const displayName = post.author || "YouTube Community Post";
  // 上部の投稿者欄は「表示名 (@ユーザー名)」として表示する。
  const identity = handle ? `${displayName} (@${handle})` : displayName;
  const title = escapeHtml(identity);
  const bodyText = buildPostBodyText(post);
  const description = escapeHtml(bodyText);


  const postUrl = escapeHtml(post.post_url || "");
  // 埋め込み用の画像URLは必ず自前の /g/ GIFプロキシ経由にする。
  // （従来の ?gif=1 相当の挙動を固定化。fifeの素URLは拡張子が無く、
  // Discord側でメディアとして扱いにくいこと・gifプロキシは
  // Content-Type: image/gif / Content-Disposition: inline を明示送达
  // できることが実測済みの理由。）
  const images  = post.images.map((img) => {
    const u = size ? buildUrl(img.base, size) : img.largest;
    if (baseUrl && img.hash && Number.isFinite(img.largest_size)) {
      const sz = size || img.largest_size;
      return escapeHtml(`${baseUrl}/g/${img.hash}/${sz}.gif`);
    }
    return escapeHtml(u);
  });
  // 画像添付が無く動画共有がある場合は、その動画サムネイルを埋め込み画像に使う。
  // i.ytimg.com の静的JPEGで署名不要・安定しているため直接指定する。
  const ogImageUrls = images.length
    ? images
    : post.video?.thumbnail
      ? [escapeHtml(post.video.thumbnail)]
      : [];
  const ogImages = ogImageUrls.map((u) => `<meta property="og:image" content="${u}" />`).join("\n");
  const twImage  = ogImageUrls[0] ? `<meta name="twitter:image" content="${ogImageUrls[0]}" />` : "";

  // 動画タグ（og:video / twitter:player）は出さない。
  // 実測した FixupX のGIF投稿の埋め込みHTML（2026-10-15 取得）には
  // og:video / twitter:player が一切存在せず、リッチカードとアニメーション
  // は activity+json 経由の media_attachments で実現されていた。
  //   media_attachments: [{ type: "image",
  //     url: "https://gif.fxtwitter.com/tweet_video/<id>.gif",
  //     meta: { original: { width, height, size, aspect } } }]
  // つまり動画URLではなく「実体がGIFであるURL」を1枚渡す形が正解。
  // うちの場合は /g/ プロキシがその実体GIF（Content-Type: image/gif）を
  // 返すので、activity+json の url にこれを指定する。
  // https://n0/rich-discord-link-embeds によれば media_attachments に
  // meta.original.{width,height,size,aspect} が無いとDiscordが構造不正と
  // 見なして通常のOGカードへフォールバックするため、必ず付ける。
  const firstImage = post.images[0];
  const videoTag = "";

  // oEmbedのauthor_nameには「表示名」ではなく統計行（💬🔁❤️👁️）を渡すのが正解。
  // 実物のFxTwitterのoEmbedリンクを確認したところ、textパラメータに
  // 統計行そのものが入っていた（例: "💬 12   🔁 345   ❤️ 4.6K   👁️ 214.0K"）。
  // 表示名は og:title / twitter:title 側で表示される。
  const engagementText = buildEngagementText(post);
  const oembedHref = baseUrl
    ? `${baseUrl}/oembed?text=${encodeURIComponent(engagementText)}&status=${encodeURIComponent(post.post_id || "")}&author=${encodeURIComponent(handle || "")}`
    : null;
  const oembedLink = oembedHref
    ? `<link rel="alternate" href="${escapeHtml(oembedHref)}" type="application/json+oembed" title="${title}" />`
    : "";

  // 実物のfxtwitter.comを確認したところ、activity+jsonのlinkタグは
  // 素のUAでは出ておらず、Discordbotとして叩いた時だけ出現した。
  // そのため isDiscordBot の時だけ埋め込む。リンク先のIDも実物同様、
  // postIdをそのまま使わず数値文字列へ変換したものを使う。
  //
  // 以前はハンドルが非ASCII（日本語など）だと弾く実装にしていたが、
  // 実データで比較したところ真因はハンドルの文字種ではなく、
  // postId自体に "_" や "-" が含まれているかどうかだった（本物の
  // Twitter/MastodonのステータスIDは数字のみのため、Discord側が
  // URLパスを見て「数字のみか」を判定していると考えられる）。
  // postIdを常に数値文字列へ変換することでこの問題ごと解消されるため、
  // ハンドルの文字種によるフォールバックは撤廃した。
  //
  // ?activity=0 で suppress 可能（DiscordでのA/B切り分け用）。
  // FixupXも activity+json リンクを出しているため、デフォルトは出す。
  // 埋め込み画像は常に自前 /g/ GIFプロキシ経由なので、status ID も
  // GIFプロキシ有効フラグ（"3"/"4"）を常に付けて生成する。
  // 読み戻しは flag "1"/"2" も受け付けます（過去デプロイで発行済みのID）。
  const numericId = postIdToNumeric(post.post_id || "", true);
  const activityHref =
    isDiscordBot && activityEnabled && baseUrl && handle && numericId
      ? `${baseUrl}/users/${encodeURIComponent(handle)}/statuses/${numericId}`
      : null;
  const activityLink = activityHref
    ? `<link rel="alternate" href="${escapeHtml(activityHref)}" type="application/activity+json" />`
    : "";

    const avatarIcon = post.avatar
    ? `<link rel="apple-touch-icon" href="${escapeHtml(post.avatar)}" />`
    : "";
  // og:site_name("YouTube")の横に出る小さいロゴ用。apple-touch-iconは
  // 投稿者アバター用に使っているので、サイト名バッジには通常のrel="icon"
  // でYouTube公式のfaviconを直リンクする（自前で保存・再配布はしない）。
  // og:site_name("YouTube")の横に出る小さいロゴ/フッターのアイコン用。
  // FxTwitterの実物は.ico形式を一切使わずSVG+複数サイズのPNGだけを
  // rel="icon"で列挙していた。うちは.ico形式(favicon.ico)を使っていたが、
  // Discordのこの部分のクローラーが.icoを認識できず投稿者アバターに
  // フォールバックしていた可能性があるため、PNG形式に切り替える。
  // og:site_name("YouTube")の横に出る小さいロゴ/フッターのアイコン用。
  // ビルドハッシュ付きの内部パス(/s/desktop/{hash}/img/...)は将来変わって
  // 壊れる可能性があるため、常に動作確認済みの安定したURLを使う。
  // og:site_name("YouTube")の横に出る小さいロゴ/フッターのアイコン用。
  // FixTweetの実ソース(branding.json + status.ts)を確認したところ、
  // これはJSON側のフィールドではなく、HTMLの<link rel="icon">を
  // svg → 64 → 48 → 32 → 24 → 16 の順に複数並べる方式だった。
  // YouTubeには複数サイズのPNG一式が公式には用意されていないため、
  // 確実に取得できるfavicon.icoを各サイズに割り当てる（画質は劣るが
  // 構造自体は実物と同じにする）。
  // YouTubeが実際に提供しているPNGサイズ(144,96,48,32)を大きい順に、
  // ビルドハッシュに依存しない内部プロキシ(/internal/faviconNN.png)経由で使う。
  const siteIcon = baseUrl
    ? ["144", "96", "48", "32"]
        .map(
          (size) =>
            `<link rel="icon" href="${baseUrl}/internal/favicon${size}.png" sizes="${size}x${size}" type="image/png" />`
        )
        .join("\n")
    : "";
  // FxTwitter系と同じOpen Graphの公開日時。Discordの下部時刻用に渡す。
  const articlePublishedTime = post.published_at
    ? `<meta property="article:published_time" content="${escapeHtml(post.published_at)}" />`
    : "";
  return `<!DOCTYPE html>

<html>
<head>
<meta charset="utf-8">
<meta property="og:type"        content="article" />
${articlePublishedTime}
<meta property="og:site_name"   content="YouTube" />
<meta property="og:title"       content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url"         content="${postUrl}" />
${ogImages}
<meta name="theme-color"        content="#FF0000" />
<meta name="twitter:card"       content="summary_large_image" />
<meta name="twitter:site"       content="@${handle ?? ""}" />
<meta name="twitter:title"      content="${title}" />
<meta name="twitter:description" content="${description}" />
${twImage}
${videoTag}
${avatarIcon}
${siteIcon}
${oembedLink}
${activityLink}
</head>
<body>
${
  post.post_url
    ? `<script type="text/javascript" language="JavaScript">
<!--
window.location.replace("${post.post_url.replace(/"/g, '\\"')}");
//-->
</script>
<noscript>
<p style="font-family:sans-serif;text-align:center;margin-top:2em;">
<a href="${escapeHtml(post.post_url)}"
   style="display:inline-block;padding:0.8em 1.6em;background:#FF0000;color:#fff;
          text-decoration:none;border-radius:6px;font-size:1.1em;">
  ▶ YouTube で見る
</a>
</p>
</noscript>`
    : ""
}
</body>
</html>`;
}

// ─── ハンドラ ─────────────────────────────────────────────────────────────────

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ─── 投稿レスポンスキャッシュ ───────────────────────────────────────────────
// 投票は票数が変化するため保存しない。通常投稿は6時間キャッシュする。
const POST_CACHE_SECONDS = 60 * 60 * 6;
// 表示仕様を変更した際はこの値を上げることで古いレスポンスを即座に回避できる。
const POST_CACHE_VERSION = "v14";

function getPostCacheKey(request) {
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("_post_cache", POST_CACHE_VERSION);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function responseWithCacheHeaders(response, cacheState, cacheControl) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Post-Cache", cacheState);
  headers.set("X-Post-Cache-Version", POST_CACHE_VERSION);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function getCachedPostResponse(request) {
  if (request.method !== "GET") return null;
  const cached = await caches.default.match(getPostCacheKey(request));
  return cached
    ? responseWithCacheHeaders(cached, "HIT", `public, max-age=${POST_CACHE_SECONDS}, s-maxage=${POST_CACHE_SECONDS}`)
    : null;
}

async function cachePostResponse(request, response) {
  if (request.method !== "GET") return response;
  const cacheable = responseWithCacheHeaders(
    response,
    "MISS",
    `public, max-age=${POST_CACHE_SECONDS}, s-maxage=${POST_CACHE_SECONDS}`
  );
  // 応答自体はすぐ返し、キャッシュ書き込みの失敗で投稿取得を失敗させない。
  await caches.default.put(getPostCacheKey(request), cacheable.clone()).catch(() => {});
  return cacheable;
}

function noStorePostResponse(response) {
  return responseWithCacheHeaders(response, "BYPASS-POLL", "no-store");
}

// TweetFix (FixTweet) の src/realms/*/routes/oembed.ts と同じレスポンス形状。
// author_name はカード上部の投稿者欄。title は返さず、リンク付き見出しを作らない。
function oembedResponse(url) {
  const text = url.searchParams.get("text") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const statusUrl = status ? `https://www.youtube.com/post/${status}` : url.origin;
  return jsonResponse({
    author_name: text || "YouTube コミュニティ投稿",
    // 相対URL（例: "/@tierun"）はJSON文脈では無効になりうるため、
    // activity+json側のaccount.urlと同じく常に絶対URL（投稿URL）を使う。
    author_url: statusUrl,
    provider_name: "YouTube",
    provider_url: "https://www.youtube.com",
    // 実物のFixupX（GET /owoembed 実測 2026-10-15）は title:"Embed" を
    // 必ず付けている。Discordは表示に使わないが、title が無いと
    // oEmbed の必須フィールドとして不正扱いされる可能性があるため合わせる。
    title: "Embed",
    type: "rich",
    version: "1.0",
  });
}


// TweetFix (FixTweet) の src/embed/activity.ts 相当。
// Discord は <link rel="alternate" type="application/activity+json"> を見つけると
// このURLをMastodonの投稿とみなして取得し、アバター・統計・画像付きの
// リッチな埋め込み（スクショのようなカード）を描画する。
//
// 参考: https://github.com/n0/rich-discord-link-embeds
//   - media_attachments には meta.original.{width,height,size,aspect} が無いと
//     Discordが構造不正とみなし、黙って通常のOGカードへフォールバックする。
//   - account.url / account.uri はプロフィールURLではなく「投稿(status)自体のURL」
//     を指す必要がある（FxEmbedの挙動に合わせているとのこと）。
function buildActivityJson(post, origin) {
  const handle = extractHandle(post.channel_url);
  const displayName = post.author || "YouTube Community Post";
  const content = bodyTextToHtml(buildPostBodyText(post));

  // YouTubeの画像URLは正確な width/height を返さないため、
  // "=sNNN" の N（バウンディングボックスの一辺）を正方形近似として使う。
  // 実測した FixupX のGIF投稿（2026-10-15 / /api/v1/statuses/:id 取得）と
  // 同じ形にする: type は "image"、url は「実体がGIFであるURL」。
  // うちの場合は /g/ プロキシがその実体GIF（Content-Type: image/gif,
  // Content-Disposition: inline）を返すので、これを渡す。
  // meta.original.{width,height,size,aspect} は Discord が構造不正と
  // 見なさないために必須（n0/rich-discord-link-embeds）。
  const mediaAttachments = post.images.length
    ? post.images.map((img, i) => {
        const size = img.largest_size || 1200;
        const url =
          origin && img.hash && Number.isFinite(size)
            ? `${origin}/g/${img.hash}/${size}.gif`
            : img.largest;
        return {
          id: `${post.post_id || "media"}-${i}`,
          type: "image",
          url,
          // 実物のFixupX（GET /api/v1/statuses/:id 実測 2026-10-15）は
          // GIF添付の preview_url を null にしている。url 側だけが実際の
          // メディアを指す形なので、ここもそれに合わせる。
          preview_url: null,
          remote_url: null,
          preview_remote_url: null,
          text_url: null,
          description: null,
          meta: {
            original: {
              width: size,
              height: size,
              size: `${size}x${size}`,
              aspect: 1,
            },
          },
        };
      })
    : post.video?.thumbnail
      ? [
          (() => {
            const w = post.video.thumbnail_width || 720;
            const h = post.video.thumbnail_height || 404;
            return {
              id: `${post.post_id || "video"}-0`,
              type: "image",
              url: post.video.thumbnail,
              preview_url: null,
              remote_url: null,
              preview_remote_url: null,
              text_url: null,
              description: null,
              meta: {
                original: {
                  width: w,
                  height: h,
                  size: `${w}x${h}`,
                  aspect: Number((w / h).toFixed(2)),
                },
              },
            };
          })(),
        ]
      : [];

  return {
    id: post.post_id,
    url: post.post_url,
    uri: post.post_url,
    // YouTubeのdatePublished/publishDateから得た正確なISO 8601時刻。
    created_at: post.published_at,
    edited_at: null,
    reblog: null,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    language: "ja",
    content,
    spoiler_text: "",
    visibility: "public",
    application: { name: "YouTube", website: "https://www.youtube.com" },
    media_attachments: mediaAttachments,
    account: {
      id: handle || post.author,
      display_name: displayName,
      username: handle || displayName,
      acct: handle || displayName,
      // プロフィールURLではなく投稿URLを指す（ドキュメント記載の仕様）
      url: post.post_url,
      uri: post.post_url,
      created_at: new Date().toISOString(),
      locked: false,
      bot: false,
      discoverable: true,
      indexable: false,
      group: false,
      // Discordがアクティビティ投稿の投稿者欄へ表示するチャンネルアイコン。
      avatar: post.avatar ?? undefined,
      avatar_static: post.avatar ?? undefined,
      avatar_remote_url: post.avatar ?? undefined,
      header: undefined,
      header_static: undefined,
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      hide_collections: false,
      noindex: false,
      emojis: [],
      roles: [],
      fields: [],
    },
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };
}

function activityJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    // FixTweet実装(Hono の c.json())も普通の application/json を返しており、
    // application/activity+json ではない。Discordはリンクタグのパス形状
    // (/users/USER/statuses/ID) だけを見て「Mastodon投稿らしい」と判断し、
    // 実データは /api/v1/statuses/:id へ普通のJSONとして取得しに来る。
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// 本家Mastodon APIの GET /api/v1/instance が返す "icon" 配列は、
// 個々の投稿者アバターとは別の「サーバー(インスタンス)全体のロゴ」を
// 表す公式フィールド（Mastodon 4.3.0で追加）。FixTweetの実装には見当たら
// なかったが、Discord（や本物のMastodonクライアント）がこのエンドポイント
// も見に行っている可能性を考え、YouTube公式ロゴを指す形で実装しておく。
function instanceJsonResponse() {
  const iconSizes = [16, 32, 48, 64, 96, 128, 256, 512];
  return jsonResponse({
    domain: "www.youtube.com",
    title: "YouTube",
    version: "4.3.0",
    source_url: "https://www.youtube.com",
    description: "YouTube Community Posts",
    thumbnail: {
      url: "https://www.youtube.com/favicon.ico",
    },
    icon: iconSizes.map((size) => ({
      src: "https://www.youtube.com/favicon.ico",
      size: `${size}x${size}`,
    })),
    languages: ["ja", "en"],
    registrations: { enabled: false },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── ドキュメント（プレーンテキスト） ─────────────────────────────────────────

const DOCS_JA = `yt-post — YouTube コミュニティポスト抽出API
========================================================

概要
----
YouTube コミュニティポストのURL/IDを渡すと、本文・画像・投票・リンク等を
抽出して返す。Discord等のリンク展開bot向けにOGタグ付きHTMLをデフォルトで返す。

使い方
------
  GET /post/<postId>
  GET /?url=<youtube_post_url>          （後方互換）

例:
  https://ytp.drks.f5.si/post/UgkxXXXXXXXXXXXXXXXXXXXX

クエリパラメータ
----------------
  format=json   生データをJSONで返す（省略時はOG HTML）
  titles=0      本文中リンクのタイトル取得をスキップ（速い）
  comments=0    コメント数の取得をスキップ（追加のAPIリクエストを省略、速い）
  size=<px>     画像サイズを指定（例: size=1205）。省略時はそのポストで
                実際に確認できる最大サイズを使用
  activity=0    activity+json リンクを出さない（Discordでの切り分け用）
      lang=en       このdocsを英語で表示

未知のパラメータ（?a=b、YouTube共有時に付く ?si=... など）は無視される。

レスポンス（format=json）の主なフィールド
------------------------------------------
  post_id       ポストID
  author        投稿者チャンネル名
  channel_url   チャンネルURL
  text          本文（リンクは [表示テキスト](URL) 形式）
  links         本文中のリンクURL一覧
  published     投稿日時（例: "2 日前"）
  likes         いいね数
  comment_count コメント数（取得失敗時は null。継続トークン経由の追加リクエストが必要なため
                titles と同様に comments=0 でスキップ可能）
  post_url      ポストURL
  poll          投票がある場合のみ: { total_votes, choices: [{text, image}] }
  images        添付画像一覧: [{ base, hash, sizes, largest, largest_size }]
                  sizes は原文URLのまま（-rwa 付き含む）。埋め込み用の
                  largest のみ形式サフィックス除去済みの素URL（GIFはアニメGIF）。
                  画像1枚目には FxEmbed 方式の動画タグ（H.264 MP4）も付く。
                  バナークロップ・失効付き署名URLは除外される。
                  画像付き投稿では activity+json リンクを出さない
                  （DiscordのMastodonカード優先描画の回避）

注意事項
--------
  - 投票の選択肢サムネイルおよびチャンネル/コメント投稿者のアバターは
    本文添付画像（images）から自動的に除外される。
  - 複数画像添付のポストは images 配列に複数エントリが入る。
`;

const DOCS_EN = `yt-post — YouTube Community Post Extraction API
========================================================

Overview
--------
Given a YouTube community post URL/ID, extracts the text, images, poll,
and links, and returns them. Returns OG-tagged HTML by default, suitable
for link-unfurling bots such as Discord's.

Usage
-----
  GET /post/<postId>
  GET /?url=<youtube_post_url>          (backward compatible)

Example:
  https://ytp.drks.f5.si/post/UgkxXXXXXXXXXXXXXXXXXXXX

Query Parameters
-----------------
  format=json   Return raw data as JSON (default: OG HTML)
  titles=0      Skip fetching titles for links found in the post text (faster)
  comments=0    Skip fetching the comment count (avoids an extra API request, faster)
  size=<px>     Request a specific image size (e.g. size=1205). Defaults to
                the largest size actually available for that post
  activity=0    Omit the activity+json link (for Discord A/B testing)
  lang=ja       View these docs in Japanese (default)

Unknown parameters (e.g. ?a=b, or YouTube's own ?si=... share tracking
param) are silently ignored.

Main fields in the response (format=json)
------------------------------------------
  post_id       Post ID
  author        Author channel name
  channel_url   Channel URL
  text          Post body (links rendered as [label](url))
  links         List of link URLs found in the body
  published     Publish time (e.g. "2 days ago")
  likes         Like count
  comment_count Comment count (null if unavailable; requires an extra request via
                a continuation token, skip with comments=0 like titles)
  post_url      Post URL
  poll          Present only for poll posts: { total_votes, choices: [{text, image}] }
  images        Attached images: [{ base, hash, sizes, largest, largest_size }]
                  sizes keeps original URLs (incl. -rwa). largest is the plain
                  URL (animated GIF for GIFs). First image also gets FxEmbed-style
                  video tags (H.264 MP4). No activity+json link for posts with
                  images (avoids Discord preferring a static Mastodon card)

Notes
-----
  - Poll choice thumbnails and channel/commenter avatars are automatically
    excluded from the "images" field.
  - Posts with multiple attached images will have multiple entries in the
    images array.
`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        },
      });
    }

    // ─── /internal/faviconNN.png ────────────────────────────────────────────
    // YouTubeのPNG faviconはビルドハッシュ入りURLでしか提供されておらず、
    // ハードコードすると将来のハッシュ変更で壊れる。getYoutubeFaviconMap()
    // で「今の」URLをCache API経由で動的解決し、そのままプロキシする。
    const faviconMatch = url.pathname.match(/^\/internal\/favicon(\d+)\.png$/);
    if (faviconMatch) {
      const wantedSize = faviconMatch[1];
      try {
        const map = await getYoutubeFaviconMap();
        const target = map[wantedSize] || map["32"] || map["ico"];
        if (!target) return new Response(null, { status: 404 });

        const res = await fetch(target, { headers: FETCH_HEADERS });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }

    // ─── /favicon.ico ─────────────────────────────────────────────────────
    // 多くのクローラー（Discord含む）は<link rel="icon">を読む前に、
    // 慣習としてドメイン直下の /favicon.ico を直接チェックしに来ることがある。
    // リダイレクトだとクローラーによっては追わないことがあるため、
    // YouTube公式のfaviconをこちらで取得してそのまま返す（保存はしない、
    // リクエストの都度プロキシするだけ）。
    if (url.pathname === "/favicon.ico") {
      try {
        const res = await fetch("https://www.youtube.com/favicon.ico", {
          headers: FETCH_HEADERS,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type": res.headers.get("Content-Type") || "image/x-icon",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    }

    // ─── /g/<hash>/<size>.gif ───────────────────────────────────────────
    // fife 素URLは拡張子なし。Discord Range/MIME 問題を回避するために
    // 自ドメインの .gif パスで包み、バイト転送する。実体は =sXXX-nd-v1。
    // フルGETのみCache API 6時間保存。
    const gifMatch = url.pathname.match(/^\/g\/([A-Za-z0-9_\-]+)\/(\d+)\.gif$/);
    if (gifMatch) {
      const [, hash, sizeStr] = gifMatch;
      if (request.method === "GET" && !request.headers.get("Range")) {
        const cachedResponse = await getCachedPostResponse(request);
        if (cachedResponse) return cachedResponse;
      }
      const target = `https://yt3.ggpht.com/${hash}=s${parseInt(sizeStr, 10)}-nd-v1`;
      try {
        const fwdHeaders = new Headers(FETCH_HEADERS);
        const range = request.headers.get("Range");
        if (range) fwdHeaders.set("Range", range);
        const upstream = await fetch(target, {
          headers: fwdHeaders,
          method: request.method === "HEAD" ? "HEAD" : "GET",
        });
        if (!upstream.ok) return new Response(null, { status: upstream.status });
        const headers = new Headers();
        headers.set("Content-Type", "image/gif");
        const disposition = "inline; filename=\"" + hash + "-" + sizeStr + ".gif\"";
        headers.set("Content-Disposition", disposition);
        for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        const response = new Response(
          request.method === "HEAD" ? null : upstream.body,
          { status: upstream.status, headers }
        );
        if (request.method === "GET" && !range && upstream.status === 200) {
          return await cachePostResponse(request, response);
        }
        return responseWithCacheHeaders(response, "BYPASS-RANGE", "no-store");
      } catch {
        return new Response(null, { status: 502 });
      }
    }

    // ─── /v/<hash>/<size>.mp4 ────────────────────────────────────────────
    // 埋め込み用MP4の拡張子付き公開URL。fife の素URLは拡張子を持たないため、
    // Discordのメディア取り扱い向けに自ドメインの .mp4 パスで包み直す。
    // 302ではなくバイト転送する（Discordモバイルでリダイレクトが初回失敗する
    // 報告があるため）。実体は withVideo()（=sXXX-rh → H.264 MP4）。
    // ステートレスでCache APIに6時間載せるため、fifeへの取得は各URL6時間に
    // 1回だけ。Workersのegress課金はない。
    const videoMatch = url.pathname.match(/^\/v\/([A-Za-z0-9_\-]+)\/(\d+)\.mp4$/);
    if (videoMatch) {
      const [, hash, sizeStr] = videoMatch;
      if (request.method === "GET" && !request.headers.get("Range")) {
        const cachedResponse = await getCachedPostResponse(request);
        if (cachedResponse) return cachedResponse;
      }
      const target = `https://yt3.ggpht.com/${hash}=s${parseInt(sizeStr, 10)}-rh`;
      try {
        const fwdHeaders = new Headers(FETCH_HEADERS);
        const range = request.headers.get("Range");
        if (range) fwdHeaders.set("Range", range);
        const upstream = await fetch(target, {
          headers: fwdHeaders,
          method: request.method === "HEAD" ? "HEAD" : "GET",
        });
        if (!upstream.ok) return new Response(null, { status: upstream.status });
        const headers = new Headers();
        headers.set("Content-Type", "video/mp4");
        headers.set("Content-Disposition", `inline; filename="${hash}-${sizeStr}.mp4"`);
        for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        const response = new Response(
          request.method === "HEAD" ? null : upstream.body,
          { status: upstream.status, headers }
        );
        // フル取得のGETのみキャッシュ（206部分応答・HEADは保存しない。
        // 部分応答をCDNが誤って使い回さないよう no-store）
        if (request.method === "GET" && !range && upstream.status === 200) {
          return await cachePostResponse(request, response);
        }
        return responseWithCacheHeaders(response, "BYPASS-RANGE", "no-store");
      } catch {
        return new Response(null, { status: 502 });
      }
    }

    // ─── /api/v1/instance ───────────────────────────────────────────────
    // 本家Mastodonの GET /api/v1/instance を模したエンドポイント。
    // "icon" フィールド（サーバー全体のロゴ）を返す実験的な追加で、
    // 効果があるかは未確認（DiscordがこのURLを見に行くという確証はない）。
    if (url.pathname === "/api/v1/instance") {
      return instanceJsonResponse();
    }

    // ─── oEmbed エンドポイント（統計行のためにDiscord/Telegramが取得） ─────
    if (url.pathname === "/oembed") {
      return oembedResponse(url);
    }

    // ─── activity+json エンドポイント ─────────────────────────────────────
    // TweetFixのアイコン付きカードと同じ仕組み。<link rel="alternate"
    // type="application/activity+json" href=".../users/{handle}/statuses/{id}">
    // をDiscordが見つけると、それを「Mastodon投稿である」という目印としてのみ
    // 使い、実データは同一オリジンの Mastodon REST API 互換パス
    // "/api/v1/statuses/:id" へ独自に取得しに行く。
    // 実物のfxtwitter.comで確認済み: リンク先IDはpostIdをそのまま使わず、
    // 数値文字列へ変換したものを使う。
    const activityMatch =
      url.pathname.match(/^\/users\/([^/]+)\/statuses\/([0-9a-z]+)\/?$/) ||
      url.pathname.match(/^\/api\/v1\/statuses\/([0-9a-z]+)\/?$/);
    if (activityMatch) {
      const cachedResponse = await getCachedPostResponse(request);
      if (cachedResponse) return cachedResponse;
      // /users/:handle/statuses/:id は2番目のグループ、/api/v1/statuses/:id は1番目
      const numericId = activityMatch[2] ?? activityMatch[1];
      const postId = numericToPostId(numericId);
      if (!postId) {
        return jsonResponse({ error: "Invalid status id" }, 400);
      }
      try {
        const { html, cookie } = await fetchHtml(`https://www.youtube.com/post/${postId}`);
        const post = await extractPost(html, false, true, cookie);
        if (!post) {
          return jsonResponse({ error: "No community post found in the page" }, 404);
        }
        const response = activityJsonResponse(buildActivityJson(post, url.origin));
        return post.poll
          ? noStorePostResponse(response)
          : await cachePostResponse(request, response);
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ─── ルートアクセス: プレーンテキストdocs ───────────────────────────────
    // ただし /?url=... の後方互換ルートは壊さないよう、url パラメータが
    // 無い場合のみ docs を返す。
    if (url.pathname === "/" && !url.searchParams.get("url")) {
      const lang = url.searchParams.get("lang");
      const docs = lang === "en" ? DOCS_EN : DOCS_JA;
      return new Response(docs, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // ─── ルーティング ───────────────────────────────────────────────────────
    // /post/<postId>  →  YouTube ポスト URL に変換
    // /?url=<url>     →  そのまま使用（後方互換）
    //
    // 未知のクエリパラメータ（例: ?a=b、YouTube共有時に付く ?si=... など）は
    // 明示的に読み取ってる titles/format/size 以外すべて無視される。
    // pathname にはクエリ文字列が含まれないため、/post/<postId>?si=xxx の
    // ような形でも postId の抽出には一切影響しない。
    let postUrl;
    // 末尾のスラッシュや余計な文字が付いても postId 部分だけ拾う（$ アンカーなし）
    const pathMatch = url.pathname.match(/^\/post\/([A-Za-z0-9_\-]+)\/?/);
    if (pathMatch) {
      postUrl = `https://www.youtube.com/post/${pathMatch[1]}`;
    } else {
      // 後方互換の ?url= 経由の場合も、共有時に付く ?si=... のような
      // トラッキング用クエリをここで落としてからYouTubeへ問い合わせる。
      const rawUrl = url.searchParams.get("url");
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          postUrl = parsed.origin + parsed.pathname;
        } catch {
          postUrl = rawUrl;
        }
      } else {
        postUrl = null;
      }
    }

    if (!postUrl) {
      return jsonResponse(
        { error: "Usage: /post/<postId>  or  /?url=<youtube_post_url>" },
        400
      );
    }

    // ─── クエリパラメータ ───────────────────────────────────────────────────
    // 以下で明示的に読む4つ以外の引数（?si=..., ?a=b 等）はすべて無視される。
    const fetchTitles = url.searchParams.get("titles") !== "0";
    const fetchComments = url.searchParams.get("comments") !== "0";
    const activityEnabled = url.searchParams.get("activity") !== "0";
    const format      = url.searchParams.get("format"); // "json" のみ有効
        const size = url.searchParams.get("size")
      ? parseInt(url.searchParams.get("size"), 10)
      : null;
    const cachedResponse = await getCachedPostResponse(request);
    if (cachedResponse) return cachedResponse;
    try {

      const { html, cookie } = await fetchHtml(postUrl);
      const post = await extractPost(html, fetchTitles, fetchComments, cookie);

      if (!post) {
        return jsonResponse({ error: "No community post found in the page" }, 404);
      }

      // UA・format 問わず常に OG HTML を返す
      // （JSON が必要な場合は ?format=json で明示）
      if (format === "json") {
        if (size) {
          post.images = post.images.map((img) => ({
            ...img,
            largest: buildUrl(img.base, size),
          }));
        }
                const response = jsonResponse(post);
        return post.poll
          ? noStorePostResponse(response)
          : await cachePostResponse(request, response);
      }
      // 実物のfxtwitter.comは activity+json のlinkタグを本物のDiscordbotにしか
      // 出していなかった（他のUAだと非表示）。それに合わせてUA判定する。
      const isDiscordBot = /Discordbot/i.test(request.headers.get("User-Agent") || "");
      const response = htmlResponse(buildOgHtml(post, size, url.origin, isDiscordBot, activityEnabled));
      return post.poll
        ? noStorePostResponse(response)
        : await cachePostResponse(request, response);

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  },
};



