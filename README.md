# シルエットコインゲット

カメラに映った自分の影（シルエット）がそのままプレイヤーになり、
落ちてくるコインを体で取るブラウザゲームです。
USJ のクッパ Jr. ファイナルバトルのような遊び方をイメージしています。

- 制限時間60秒、コインを影で触るとスコア加算
- 敵（クリボー相当）に触るとスコア減、パワーダウン
- コインを一定数取ると BIG 状態になり得点2倍、色が変わる
- 感度と落下速度をスライダーで調整可能

ビルド不要・依存ライブラリ無し（Vanilla HTML/CSS/JS）で作っているため、
Windows / Mac / Linux のどの PC でも、ブラウザとローカル HTTP サーバー
さえあればそのまま動きます。

現在の実装状況は [PROGRESS.md](./PROGRESS.md) を参照してください。
（現時点では Stage 1: カメラ取得と鏡像表示のみが実装済みです）

---

## 1. 動作環境（Windows での前提）

- Windows 10 / 11
- カメラ付き PC、または USB カメラ
- 最新版の Google Chrome または Microsoft Edge（推奨）

カメラ機能 (`getUserMedia`) はブラウザの仕様上、
**`http://localhost` または `https://` 経由でアクセスした場合のみ**
動作します。`index.html` をダブルクリックして `file://` で開いても
カメラは起動しませんので、必ず下記の手順でローカルサーバーを
経由してアクセスしてください。

---

## 2. Windows でこのゲームを動かす手順

### 手順 A: リポジトリを取得する

Git がインストール済みの場合、PowerShell で以下を実行します。

```powershell
git clone https://github.com/pa314960-prog/kaken.coinget.wall.git
cd kaken.coinget.wall
git checkout claude/silhouette-coin-game-r0b6od
```

Git を使わない場合は、GitHub の "Code" → "Download ZIP" から
ダウンロードして展開してください（ブランチを
`claude/silhouette-coin-game-r0b6od` に切り替えるのを忘れないでください）。

### 手順 B: ローカル HTTP サーバーを起動する

どちらか使える方法で構いません。

**Python がインストール済みの場合（推奨・追加インストール不要なことが多い）**

```powershell
cd kaken.coinget.wall
python -m http.server 8000
```

**Node.js がインストール済みの場合**

```powershell
cd kaken.coinget.wall
npx serve -l 8000
```

Python も Node.js も無い場合は、
[Python公式サイト](https://www.python.org/downloads/) からインストーラーを
ダウンロードしてインストールしてください（インストール時に
「Add python.exe to PATH」にチェックを入れてください）。

### 手順 C: ブラウザで開く

ブラウザで次の URL を開きます。

```
http://localhost:8000/
```

「カメラ開始」ボタンを押すと、ブラウザ上部にカメラ利用許可の
確認が出ます。**「許可」をクリック**してください。
自分の姿が鏡のように左右反転して表示されれば成功です。

サーバーを止めたいときは、PowerShell のウィンドウで `Ctrl + C` を
押してください。

### 次回以降の起動方法

1. `kaken.coinget.wall` フォルダに移動する。
2. 手順 B のコマンド（`python -m http.server 8000` など）を実行する。
3. ブラウザで `http://localhost:8000/` を開く。

これだけです。インストール作業は初回のみで、2回目以降は
サーバー起動とブラウザアクセスだけで動きます。

---

## 3. Claude Code をローカルで実行して開発を続ける場合

このリポジトリの `PROGRESS.md` には、Claude（AI エージェント）が
次に何を実装すべきかを読み取れる形で進捗と手順を書いています。
Windows のご自身の PC で Claude Code CLI を動かし、この
`PROGRESS.md` を読み込ませることで、開発の続き（Stage 2, Stage 3）を
ローカルで進めることができます。カメラを使った動作確認はご自身の
PC でないとできないため、この方法がおすすめです。

### インストール（初回のみ）

1. [Node.js](https://nodejs.org/)（LTS版）をインストールする。
2. PowerShell で以下を実行し、Claude Code CLI をインストールする。

   ```powershell
   npm install -g @anthropic-ai/claude-code
   ```

3. インストール後、以下でバージョンが表示されれば成功です。

   ```powershell
   claude --version
   ```

4. 初回起動時に Anthropic アカウントでのログインを求められるので、
   画面の指示に従ってログインしてください。

   ```powershell
   claude
   ```

### このリポジトリを Claude Code に読み込ませて続きを実装させる

```powershell
cd kaken.coinget.wall
git checkout claude/silhouette-coin-game-r0b6od
git pull
claude
```

`claude` 起動後、チャットで例えば次のように依頼してください。

```
PROGRESS.md を読んで、現在の実装状況を確認してください。
Stage 2（背景記憶ボタンと背景差分マスクの可視化）を実装してください。
実装後、ローカルサーバーの起動方法と確認手順を教えてください。
```

Claude Code が実装を終えたら、指示に従ってローカルサーバーを起動し、
実際にブラウザで動作確認をしてください。問題なければ、
Claude Code に Stage 3 の実装を依頼してください。

### 次回、開発を再開するとき

同じフォルダで `claude` を実行すると、そのフォルダの会話・作業内容を
再開できます（フォルダを移動していなければ自動的に続きから始まります）。
セッションを明示的に再開したい場合は次のように実行してください。

```powershell
cd kaken.coinget.wall
claude --continue
```

新しくブランチが進んでいる場合は、事前に `git pull` を忘れずに
行ってください。

---

## 4. 今後 UI 操作が必要になるタイミング（見込み）

- Stage 2 実装後: 「背景を記憶」ボタンを押すタイミングで、
  **プレイヤーが画面に映っていない状態**にしてからボタンを押す必要が
  あります（背景差分の元になる背景画像を撮影するため）。
- Stage 3 実装後: 感度・落下速度のスライダーは、部屋の明るさや
  カメラとの距離に応じて調整が必要になる場合があります。

これら UI 操作が必要な場面は、実装が進むたびに `PROGRESS.md` と
このセクションを更新してお知らせします。

---

## 5. ファイル構成

```
index.html    ... ゲーム画面の HTML（UI 部分）
game.js       ... ゲームロジック（現在は Stage 1: カメラ取得と鏡像表示のみ）
PROGRESS.md   ... 実装の進捗・次にやることの記録（AI 引き継ぎ用）
README.md     ... このファイル（セットアップ手順）
```

修正しやすいように、HTML(UI) と JS(ロジック) を分離しています。
Stage が進むごとに `game.js` 内にセクションコメントを追加していく
方針です。
