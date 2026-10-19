# GitHub Projects Dependency Visualizer

GitHub Projects のカンバンで、Issue の依存関係と複雑さを確認する Chrome 拡張機能です。GitHub のネイティブな依存関係を読み取り、**ブロック元 → ブロック先** の矢印と解析パネルを Board に重ねて表示します。

- **重なる線を分離**: 接続点とレーンを分散し、同じ列のカード間の線は横へ迂回します。線の番号を関係一覧と照合し、一覧から選んだ関係を強調できます。
- **深さと複雑さを表示**: カードに深さ・直接の入出次数、解析パネルに最長依存段数・分岐数・合流数を表示します。カードを選ぶと、上流・下流の関係と下流への影響先件数を確認できます。
- **最長経路を追跡**: 最長の依存経路を強調し、「最長経路のみ」で絞り込めます。同じ長さの最長経路が複数あれば、すべてを対象にします。
- **循環を警告**: 循環している関係を赤い破線で表示します。循環がある間は深さ・最長経路を算出しません。

**解析対象は画面に表示されているカード間の関係です。最長経路は依存関係の辺数で計算し、期間・工数を使うクリティカルパスではありません。** 取得中は暫定値、API の取得失敗や件数上限がある場合は不完全な解析として表示します。

![同一列の依存線の分離、カードの深さ、最長経路と関係一覧を表示した公開サンプル](docs/dependency-analysis-light.png)

[Dark テーマの表示例](docs/dependency-analysis-dark.png)

## インストール

Chrome 114 以降を使用します。

1. [Releases](https://github.com/krhrtky/github-projects-dependency-visualizer/releases) を開き、`github-projects-dependency-visualizer-<version>-chrome.zip` をダウンロードして展開します。GitHub が自動生成する `Source code (zip)` は配布用の拡張機能ではありません。
2. Chrome で `chrome://extensions` を開き、「デベロッパー モード」を ON にします。
3. 「パッケージ化されていない拡張機能を読み込む（Load unpacked）」を押し、**`manifest.json` が直下にある展開フォルダ**を選びます。ZIP ファイル自体は選択しません。
4. 既に開いている GitHub タブを再読み込みします。

[GitHub Actions](https://github.com/krhrtky/github-projects-dependency-visualizer/actions/workflows/ci.yml) の成功した実行からも、`github-projects-dependency-visualizer-chrome-...` Artifact をダウンロードできます。Artifact の ZIP も直下に `manifest.json` を含むため、展開後は同じ手順で読み込めます。Actions の Artifact ダウンロードには GitHub へのログインが必要です。

更新時は読み込んだフォルダの内容を新しい ZIP の内容で置き換え、拡張管理画面で再読み込みした後、GitHub タブを再読み込みしてください。認証情報は再入力が必要です。Chrome の公式手順は [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) を参照してください。

## 使い方

1. 対象の GitHub Project の **Board** を開きます。
2. 拡張機能の Popup に Fine-grained PAT を入力し、「PAT を設定」を押します。
3. 「依存関係を表示」を ON にします。初期値は OFF です。
4. Board 右下の解析パネルで最長依存段数・分岐・合流を確認します。「最長経路のみ」、カードの選択、番号付きの関係一覧で調べたい依存関係を絞り込みます。パネルは見出しから折りたためます。
5. GitHub 上で依存関係を変更した後や、取得エラーの原因を解決した後は **Refresh** を押します。
6. **Logout** は PAT と関係キャッシュを削除し、表示を OFF にします。

| 表示 | 意味 |
| --- | --- |
| 深さ | 入ってくる依存関係がないカードを 0 とした、そこまでの最長の辺数 |
| 入 | そのカードを直接ブロックするカード数 |
| 出 | そのカードが直接ブロックするカード数 |
| 下流の影響先 | 直接・間接にブロックする、重複を除いたカード数。自分自身を除く |
| 分岐カード | 出が 2 以上のカード数 |
| 合流カード | 入が 2 以上のカード数 |
| 最長依存段数 | 可視範囲のグラフに含まれる最長経路の辺数 |

線の色だけで判断せず、番号・関係一覧・カード選択も利用できます。利用できる余白が少なく線の間隔を確保できない場合は、解析パネルに案内を表示します。

## PAT の準備

GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens から作成します。

- Resource owner に対象 Repository の所有者を選択し、有効期限を設定します。
- Repository access を **Only selected repositories** とし、取得対象の Repository を選びます。
- Repository permissions の **Issues: Read-only** を選びます。Projects の書き込み権限は不要です。
- 組織による承認が必要な場合は、承認後に利用します。

利用する `blocked_by` 一覧取得 API は、Fine-grained PAT の Issues read 権限に対応します。[GitHub 公式 API 仕様](https://docs.github.com/en/rest/issues/issue-dependencies?apiVersion=2026-03-10#list-dependencies-an-issue-is-blocked-by) を参照してください。拡張は API version `2026-03-10` を使用します。

複数 Repository の Board では、それぞれへのアクセス権限が必要です。異なる Resource owner の Repository は、単一の Fine-grained PAT でアクセスできない場合があります。PAT 設定直後の「設定済み」は保存状態を示し、有効性と権限は依存関係の取得時に検証します。

401 は認証エラー、403 は権限不足または Rate Limit、404 は権限のない非公開 Issue と削除・移動を区別できません。Popup の案内を確認してください。Rate Limit 中は待機時刻を表示し、Refresh で待機期限を迂回したり、自動再試行したりしません。

## 対応範囲と制限

- 対応 URL は `https://github.com/users/{user}/projects/{number}` と `https://github.com/orgs/{org}/projects/{number}` です。`/views/{number}` 付きにも対応します。Table、Roadmap、GitHub Enterprise Server は対象外です。
- 画面とスクロール領域に見えていて、DOM に実在する Issue カードだけを接続・解析します。画面外・仮想化されたカードを含む Project 全体の依存関係や、全体の最長経路は示しません。スクロールやフィルタで解析結果が変わります。
- 1 回の可視範囲で取得する上限は 200 個のユニークな Issue です。超過時は Popup と解析パネルに案内を表示します。取得中・部分失敗・上限超過時の数値は、完全なグラフの値として扱わないでください。
- Draft、Pull Request、Issue URL のないカード、複数の異なる Issue URL があり識別できないカードは除外します。同じ Issue が複数表示される場合は、最も近いカードの組を 1 回だけ接続します。
- 依存関係は Repository と Issue 番号で識別し、重複と自己参照を除去します。循環の警告も可視範囲の関係だけが対象です。
- API の成功結果は Background のメモリに 60 秒キャッシュします。スクロールだけで取得済みの Issue を再取得せず、新たに見える Issue を追加取得します。定期的な依存関係のポーリングは行いません。Refresh は全タブの関係キャッシュを無効化します。
- GitHub Projects の DOM は互換性が保証された API ではありません。GitHub の画面構造の変更により、Board やカードを検出できなくなる場合があります。

## セキュリティ

拡張は **読み取り専用**です。Issue、依存関係、Project のデータを更新しません。実行コードはすべて配布フォルダに含み、外部サーバー・CDN・Analytics は利用しません。

PAT は [Chrome の `storage.session`](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session) に保存し、アクセスを `TRUSTED_CONTEXTS` に制限します。Popup の入力欄は送信時に消去します。Content Script に PAT を渡しません。ブラウザの再起動、拡張の再読み込み・更新・無効化などで PAT は失われます。表示 ON/OFF だけを `storage.local` に保存し、`storage.sync` や Web の localStorage / sessionStorage は利用しません。

Background だけが `https://api.github.com/repos/.../dependencies/blocked_by` へ GET を送信します。Cookie は送信せず、リダイレクトは拒否します。送信元・メッセージ・Pagination の URL を検証し、任意 URL を取得する操作は提供しません。API レスポンスのタイトル・本文は保持・転送せず、レスポンス本体をディスクにキャッシュしません。PAT、タイトル、本文をログに出力しません。

必要な拡張権限は `storage` と `github.com` / `api.github.com` の host permissions です。GitHub 内の SPA 遷移を検出するため Content Script は `github.com/*` に読み込みますが、Board の検出と API 操作は対応する Project URL に限定します。

セッション保存は、端末の侵害や拡張コードの改変から認証情報を保護するものではありません。不具合の報告時は、PAT・認証ヘッダ・非公開 Issue の情報を含めないでください。

## 開発

Node.js 22 と pnpm 9.15.9 を使用します。

```sh
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm build` は TypeScript の型検査と本番ビルドを行います。生成された `dist/` を Chrome に読み込んでください。`pnpm dev` はファイル変更を監視して再ビルドします。ビルド後は拡張管理画面と GitHub タブを再読み込みします。Manifest を変更した場合は watch を再起動してください。

E2E は一時 Chromium Profile、模擬 GitHub ページ、模擬 API を使用し、実アカウントや実 PAT を必要としません。CI は型検査・ビルド・単体テスト・Chromium E2E を実行します。検証範囲は [検証結果](docs/verification.md)、設計判断は [アーキテクチャと ADR](docs/architecture.md) を参照してください。

## ビルドと配布

```sh
pnpm package:extension
```

`release/` に Chrome 用 ZIP と `.sha256` チェックサムを生成します。ローカルでのパッケージ生成には `zip` コマンドが必要です。ZIP には許可した `dist/` の実行ファイルだけを含め、`manifest.json` を直下に配置します。ソース・テスト・設定ファイル・ソースマップ・シンボリックリンクや、GitHub 認証情報らしい値の混入はエラーにします。

- `main` への push、Pull Request、手動 CI 実行で検証し、成功後に Chrome 用 Artifact を 30 日間保存します。
- `package.json` と `src/manifest.json` のバージョンを一致させ、`v<version>` タグを push すると、再検証後に GitHub Release へ ZIP とチェックサムを公開します。タグとビルド済み Manifest のバージョンが違う場合は公開に失敗します。
- GitHub Actions で使う Action は完全なコミット SHA で固定しています。パッケージ用の追加 npm 依存はありません。

## DOM Adapter の保守

Board と Card の検出は `src/content/board-detector.ts`、Issue の抽出は `src/content/card-extractor.ts` に集約しています。検出できない場合は、現在の Board の一意なルート、カードの境界、`/{owner}/{repo}/issues/{number}` 形式のリンクを確認してください。Table / Roadmap を誤検出しない Fixture とテストも追加します。Fixture は公開可能なデータを使い、非公開 Issue のタイトル・本文・Repository 名を含めないでください。

座標は実 DOM から取得し、未描画カードの位置は推測しません。構成は `background/` が認証と API、`content/` が検出と監視、`domain/` がグラフ解析、`renderer/` が線と解析パネル、`popup/` が設定を担当します。
