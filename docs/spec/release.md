# リリースの仕組み

このツールを npm パッケージ `@ba0918/agentic-skill-vendor` として公開する手順と、
その自動化の設計を記す。

## 方針

人間が判断するのは「いつ・どの版で出すか」だけとする。それ以外(タグ作成・npm への
公開)は機械が行う。承認点を一つに絞ることで、手順の儀式化と半端なリリース
(タグだけあって npm に無い、など)を防ぐ。

## 初回リリース(手動)

npm の trusted publishing(OIDC。長期トークンを持たず、GitHub Actions の実行時証明で
publish を認可する仕組み)は、npm 上にパッケージのページが存在しないと設定できない。
そのため初回のみ手動で publish し、その後 npm 側で trusted publisher(このリポジトリと
workflow ファイル名)を登録する。以後の publish はすべて workflow が行う。

## 自動リリース(2 回目以降)

1. 人間: version bump コミットを main に入れる。このコミットには package.json の
   版更新と、CHANGELOG の Unreleased 節の版見出しへの昇格・比較リンクの追加を含める
   (版・変更履歴・タグを 1 操作で揃えるため)。
2. workflow: main への push で bump を検知し、以下を順に行う。
   - 通常 CI(型検査・lint・format・テスト・fixture verify)を通す
   - package.json の版・既存 git タグ・npm 上の公開済み版を照合する
   - タグ v{版} を作成する(チェックが通った状態にだけタグを打つ)
   - 同じコミットから tarball をビルドし、trusted publishing で publish する

## 失敗時の挙動

- 照合の結果、同じ版が既に npm に公開済みの場合はエラーで停止する。黙って
  スキップしない。npm は同一版の再公開を許さないため、この状態は workflow の
  再実行や bump 忘れなど人間が見るべき状況であり、緑にして流すと隠れる。
- CI が失敗した場合、タグは作られず何も公開されない。修正を積んで bump をやり直す
  (公開済みタグは動かさない。失敗時点では何も公開されていないため、版もタグ名も
  消費されていない)。

## 権限

- workflow は read 権限を基本とし、タグ作成の step にのみ contents: write、
  publish の job にのみ id-token: write を与える。
- publish 前に人間の承認クリック(GitHub Environment の保護)は挟まない。
  承認点は bump コミットに一本化しているため。
