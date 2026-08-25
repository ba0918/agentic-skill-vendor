# ソースコードの責務配置

## 目的

`src/` 直下に増えた実装とテストを、変更理由が近い機能ごとに配置する。
ファイルを探しやすくするだけでなく、機能間の依存方向を機械的に検査し、
同じ規則が複数箇所へ分散することを防ぐ。

この再編は内部構造だけを変更する。コマンドライン操作、終了コード、標準出力と
標準エラー、lock、manifest、cache、ネットワーク、標準入力、外部 process、
resource limit、配布 package の内容は変更しない。

作業中に見つけた既存不具合や別の改善案は、この再編へ混ぜず別件として扱う。

## Feature 単位の配置

トップレベルは技術 layer ではなく、変更が閉じる機能単位で分ける。

```text
src/
  cli.ts
  cli/
  contracts/
  distribution/
  remote/
  filesystem/
  diagnostics/
  test-support/
  errors.ts
  records.ts
```

- `cli.ts`: npm package を build するための入口。起動処理だけを持つ
- `cli/`: 引数解析、表示、終了コード、標準入力
- `contracts/`: 契約宣言、source 表、lock、digest、raw 形式、repository 表記、
  placement 所有規則
- `distribution/`: `gen`、`verify`、placement、staging、`lint-selfcontain`
- `remote/`: `add`、`update`、`fetch`、cache、GitHub API、汎用 Git、process、token
- `filesystem/`: link を拒否する read/write と ignore 規則
- `diagnostics/`: `self-test`
- `test-support/`: fixture、fake remote、filesystem test helper
- `errors.ts` と `records.ts`: 内部 feature へ依存しない全体 primitive

実装のテストは対象実装と同じディレクトリへ置く。

`common/` や `utils/` のように所有責務が分からないディレクトリは作らない。
root に置ける production module は、内部 feature へ依存しない primitive と
package entrypoint に限定する。

## Import 境界

各 feature が import してよい相手を次のように固定する。

| Import する側 | Import してよい相手 |
| --- | --- |
| `filesystem` | root primitive |
| `contracts` | `filesystem`、root primitive |
| `distribution` | `contracts`、`filesystem`、root primitive |
| `remote` | `distribution`、`contracts`、`filesystem`、root primitive |
| `diagnostics` | `distribution`、`contracts`、root primitive |
| `cli` | 全 production feature |
| `test-support` | 全 production feature |

production code から `test-support` を import してはならない。
`distribution` から `remote` を import してはならない。これにより、
ネットワークを使わない `gen`、`verify`、`lint-selfcontain` の境界を
ソース構造でも維持する。

feature 間の循環依存は禁止する。feature をまたぐ import は、所有 feature が外部利用を
意図した module に限定する。一括 export だけを目的とした `index.ts` は作らない。

## Phase 1 — 配置と境界の固定

Phase 1 では、動作や責務を変えずにファイルを移動する。

開始時に、全 production file と test file の移動先を記録した配置表と、
許可する import の表を固定する。現在存在する境界違反は例外として明示し、
新しい例外が増えないことを機械検査する。

既知の移行対象は次の 2 種類。

- `filesystem` が `contracts` 内の文字列比較処理を利用している
- `distribution` が `remote` 内の cache 処理を利用している

移動は依存される側から行い、各単位で対象 test と型検査を実行する。
Phase 1 の最後に全 test、lint、format、build、fixture 検証、配布 package 検査、
Node、Bun、Deno での実行確認を行う。

## Phase 2 — 責務分割と重複整理

Phase 2 では、外部動作を固定する test を先に確認してから、
一つの責務または一つの重複した規則ごとに整理する。

重点確認対象は、行数が多い module、複数の外部 I/O を扱う module、
純粋な判断と I/O 調停を同時に持つ module とする。行数は確認対象を選ぶ
signal であり、分割を強制する上限ではない。

開始時に、次の候補を固定した台帳を作る。

- 構文上の重複
- 同じ検証規則
- path 処理と正規化
- UTF-8、digest、Git object ID
- filesystem error の変換
- cache、atomic write、cleanup
- CLI 引数と拒否 message
- 500 行以上の production module
- 複数の変更理由を持つ module
- Phase 1 に残った import 境界違反

構文上の重複検出には、今回の監査に限って `jscpd@5.0.16` を使用する。
`mild` mode、5 行以上、50 token 以上とし、production と test を別々に走査する。
`dist`、fixture、artifact store は除外し、`test-support` は test 側で走査する。

`jscpd` は package の依存や恒久的な CI には追加しない。重複率を品質基準にすると、
異なる契約を持つ処理まで統合する誘因になるためである。

各候補を次のいずれかへ裁定し、理由を残す。

- 同じ知識なので統合する
- 複数責務を分割する
- 契約が異なるため意図的に維持する
- 検出上似ているだけなので対象外とする

未裁定候補がなく、Phase 1 の暫定 import 例外がなくなった時点で、
責務分割と重複整理を完了とする。

## Scope の固定

Phase 1 の配置表と依存表、Phase 2 の module 一覧と候補台帳は、
各 phase の開始時に固定する。

作業中に見つけた既存不具合や別の改善案は候補台帳へ追加せず、別件として記録する。
現在の変更が新たに生んだ問題、または固定済みの完了条件を妨げる問題だけを
現在 phase で解消する。

これにより、全候補を確認しながら、調査するほど release が遠ざかる状態を防ぐ。

## 完了条件

- 全ファイルに説明可能な所有 feature がある
- 許可 import 表に違反せず、feature 間の循環依存がない
- root primitive が内部 feature へ依存しない
- production code が `test-support` へ依存しない
- 配布 package に test-support や開発専用 file が入らない
- Phase 2 の候補台帳に未裁定項目がない
- 暫定 import 例外が残っていない
- コマンドライン操作、終了コード、出力、永続形式が再編前と一致する
- filesystem 走査、network request、process 起動が増えていない
- timeout と容量上限が変わっていない
- Node、Bun、Deno で配布 package が従来どおり動く
- typecheck、test、lint、format、build、fixture 検証がすべて成功する

wall-clock 時間は実行環境によって変動するため、新しい固定値は設けない。

## Release との関係

この再編は、任意 Git ホスト対応を含む `0.6.0` の公開前に完了する。
Phase 1 と Phase 2 の両方が完了するまで version bump と release は行わない。

各 phase の初回 review では対象全体を確認し、修正後の review は指摘箇所と
追加差分だけに限定する。

## Phase 2 の固定設計

Phase 2 は、行数を減らす作業ではなく、同じ理由で変更される規則を一つの場所へ集め、
異なる理由で変更される処理を独立して検証できる単位へ分ける作業とする。

### 暫定依存の所有権

Phase 1 に残った4つの暫定importは、次の所有権へ整理して除去する。

| 規則 | 所有者 | 理由 |
| --- | --- | --- |
| localeに依存しない決定的な文字列順序 | root primitiveの`src/ordering.ts` | digest固有ではなく、tool全体の出力と走査順を再現可能にする規則である |
| cacheのdirectoryとfile path | `contracts` | fetchする側とofflineで読む側が共有する保存形式である |
| repository作業directoryのignore判定と警告 | `filesystem` | cache以外のstaging directoryにも適用するfilesystem policyである |
| cacheの列挙、prune、取得後のlifecycle | `remote` | remote materialを取得・更新した後の操作である |

`common/`や`utils/`のように所有者を説明できない場所は作らない。`ordering.ts`は
一つの明確なprimitiveだけを所有し、内部featureへ依存してはならない。

### Module の裁定

次のmoduleは複数の変更理由を持つため、同じfeature内で責務単位へ分ける。

| Module | 分離する責務 |
| --- | --- |
| `distribution/placements.ts` | raw入力、配置計画とmigration・sweep、違反検査 |
| `distribution/gen.ts` | contract探索、生成計画、書込み、lock導出とreport、command調停 |
| `remote/resolvecmd.ts` | snapshot計画、source収集、cache配置、lock更新、command調停 |
| `contracts/sources.ts` | schema検証とparse、line-preserving manifest編集 |
| `contracts/manifest.ts` | lock modelと導出、JSON codecと検証、filesystem読取 |
| `filesystem/walk.ts` | read・traversal・kind guard、atomic write |
| `test-support/testing.ts` | CLI実行、fixture操作、filesystem補助、fake remote、assertion補助 |

`remote/gitprocess.ts`は行数が多くても一体維持する。process groupの停止確認、source単位の
resource budget、cleanup、停止未確認時のtemporary repository保持は一つの安全状態機械であり、
別moduleへ分散すると拒否状態の組合せを機械検査しにくくなるためである。

500行未満のmoduleも候補台帳では確認する。ただし、一つのtransport adapterや一つの
command boundaryとして変更理由を説明でき、独立したtestを持つものは行数だけで分割しない。

### 重複の裁定

Productionの構文上の重複は、同時に変更される知識だけを統合する。callerごとに異なる
拒否message、trust boundaryでの明示的なvalidator呼出し、異なる入力形式の防御は維持する。

特に次を一つの正本へ寄せる。

- documentとraw materialで共有する、sourceの登録・pin・cache不足の分類
- `gen`と`verify`で共有する、kind確認からdocument・raw読取までのtree準備
- placement pathから末尾separatorを除く正規化規則

Testの重複は、全検出hitを知識groupへ対応付けたうえで裁定する。fixture作成、一時directoryの
lifecycle、fake transportの組立、同じruntime matrixは統合候補とする。一方、assertion、期待値、
security境界の入力、command固有の拒否契約、手計算したdigestなどproductionから独立すべき値は
localに維持する。production実装と同じhelperで期待値を生成してはならない。

### 固定台帳

Group化した候補とその裁定はPhase 2 plan本体へ置く。`jscpd`の全hitから各groupへの対応表は、
package、Git管理、CIへ含めず、local artifact storeのreview artifactとして保持する。

Planには`jscpd`のversionと実行条件、対象commit、凍結日時、対応表artifactのpathとdigestを残す。
対応表を修正する場合は既存artifactを上書きせずrevisionを追加し、planの参照を更新する。

### Effect の固定

変更前のtreeから、公開出力と副作用の順序をbaselineとして採取する。次は回数、順序、対象を
変えない。

- network requestのhost、引数、回数、順序
- subprocessの引数、environment、回数、順序
- credential用standard inputを読む時点と最大回数
- filesystemのwrite、rename、deleteの対象と順序
- resource budgetの集計単位
- process停止確認、cleanup、retentionの順序
- offline commandがnetworkやsubprocessへ到達しないこと

Filesystem readは個々の`stat`回数を固定しない。ただし、読むtreeの範囲を広げず、同じtreeの
重複走査を増やさず、symlink拒否、容量上限、外部結果を変えない。

Phase 2は永続形式、migration、dependency、versionを変更しない。初回reviewだけ対象全体を読み、
修正後は前回指摘とその修正で生じた追加差分だけをreviewする。
