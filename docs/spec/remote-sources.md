# リモート source(クロスリポジトリの共有文書取得)

本ツールはこれまで、契約(スキルへ配布する共有文書)の正本(編集してよい唯一のファイル)を
同一リポジトリ内の contracts/<id>.md に限ってきた。本章は、正本を別のリポジトリに置き、
そこから取得して配布する「リモート source」を定義する。動機は、複数のスキルリポジトリが
同じ共有文書を使うとき、リポジトリごとの手動コピーで正本が複製され、コピー同士のずれを
検出する手段がないことである。

## 正本の配置 — owner の分散

共有文書の正本は、契約ごとに「その文書へ一番関係が深いリポジトリ」(owner)へ1つだけ置く。
共有文書専用の中央リポジトリは設けない。消費側は契約ごとに出典を記録するため、正本の
引っ越しは記録1行の変更で済む。どのリポジトリにも収まらない中立の文書が実際に数個
確定した時点で、中央リポジトリの導入を再検討する。

## manifest — 全契約の出典を載せた表。書記はツール

宣言ファイル `vendor-manifest.yaml` は、source(取得元リポジトリ)の一覧と、
この リポジトリが使う**全契約**(ローカル・リモートの両方)の出典を載せた表である。
最終的なファイルは次の形になる。

```yaml
sources:
  workflow:
    repository: ba0918/agentic-workflow   # owner/repo 短縮形のみ。URL は書けない
    ref: main                             # branch / tag / commit SHA
  meta:
    repository: ba0918/agentic-meta
    ref: main

contracts:
  report-format:
    source: local                         # このリポジトリの contracts/report-format.md が正本
  writing-style:
    source: local
    path: docs/style/writing-style.md     # local でも規約位置に無い正本は path で指せる
  tdd-contract:
    source: workflow                      # path 省略時は規約位置 contracts/tdd-contract.md
  information-placement:
    source: meta
    path: rules/information-placement.md  # 規約位置に無い正本だけ path を明示する
```

path は local を含むすべての source で同じ意味を持つ(省略時の既定値が規約位置
contracts/<id>.md、明示すればその位置が正本)。local が特別なのは取得が要らないことだけで、
スキーマ上はただの source である。

このファイルは人間が手書きで維持するものではない。**書記はツール**であり、人間の仕事は
次の3つに限られる。

1. `add <owner/repo>` で source を登録する(ref は取得先の既定 branch を問い合わせ、
   明示値として記録される)
2. スキルの SKILL.md frontmatter に契約 id を宣言する(従来どおり。これ自体が依存宣言)
3. 曖昧さの解消と規約外パスの指定だけ、contracts の行を手で書く

contracts の行は、宣言された id からツールが導出して書き足す。導出規則:

- ローカルの contracts/<id>.md が在れば `source: local`
- 無ければ、登録済み source の規約位置 contracts/<id>.md を探す。ちょうど1つで
  見つかればその source を記録する
- どの source にも無ければ従来どおり closure として停止する
- **複数の source で見つかった場合は黙ってどちらかを勝たせず、エラーで停止して
  contracts の行の明示を要求する**。「1 契約 1 出典」の強制が、正本の多重管理を
  顕在化させる安全装置になる

導出が探すのは規約位置だけであり、規約位置に無い正本(local・リモートとも)を指す行は
常に人間が書く。人間が書いた明示の行はそれ自体が曖昧さの裁定なので、規約位置の探索より
常に優先され、探索で別の候補が見つかってもエラーにはならない。local の path が指せるのは
このリポジトリ内の通常ファイルだけで、skills/ 配下とキャッシュディレクトリ配下は
指せない(スキル内のファイルを正本にすると、スキル間の暗黙依存が生まれるため)。

ツールによる manifest の書き換えは必ず報告行を伴い、git の差分としてレビューされる。
契約 id はローカル・リモートで同一の名前空間であり(source 名 `local` は予約)、
contracts は id を鍵とする単一の対応表なので、同一 id の二重記録は構造上書けない。
スキル側の宣言(SKILL.md)は従来どおり id だけを書く。

manifest が存在しないリポジトリは、全契約ローカルの従来挙動のまま動く(後方互換)。
manifest は最初の `add` で生まれ、以後この表が維持される。

## lock — ツールだけが書く解決結果

`vendor-lock.json`(従来の vendor-manifest.json の改名)は、実際に採用した版の記録である。
従来の2節に sources 節が加わる。

```json
{
  "dependencies": { "skill-a": ["tdd-contract"] },
  "resolutions": { "tdd-contract": { "digest": "sha256:..." } },
  "sources": {
    "workflow": { "repository": "ba0918/agentic-workflow", "revision": "0123abcd…(40桁 SHA)" }
  }
}
```

- manifest の ref が branch / tag でも、lock には必ず commit SHA(git の特定時点を一意に
  指す識別子)が記録される
- resolutions の digest(内容から計算するハッシュ値。バイト一致の証明に使う)と
  conformance digest(契約に付属する適合テスト一式のハッシュ値)の書き手は従来どおり
  gen のみ。sources の revision の書き手は update / add である
- 契約と source・path の対応は manifest が持つため、lock には重複して記録しない

## 取得物の置き場所 — コミットしない

消費リポジトリにコミットされるのは manifest・lock・配布コピー(各スキル配下に生成される、
正本とバイト同一のコピー)のみとする。取得した正本のミラーを contracts/ に置くことは
しない。ミラーは誰も編集してはいけない第二のコピーであり、正本と誤認される入口になる。

取得物は `.agentic-skill-vendor/cache/<source名>/<revision>/<取得元path>` に置く。
このディレクトリは gitignore の対象であり(ignore されていない場合、取得時に警告する)、
場所が --root 相対で決まるため、環境変数を読まないという既存の不変条件が保たれる。
キャッシュは使い捨てであり、正しさの根拠にしない。保持するのは lock が名指しする
契約ファイルと conformance ツリーのみで(source リポジトリ丸ごとは保持しない)、
lock から参照が消えた revision のエントリは取得時に掃除する。全削除しても fetch で
復元できる。

## コマンド境界 — ネットワークは add / update / fetch のみ

- add: source を manifest に登録し、その場で update 相当(解決・取得)まで行い、
  宣言済み id のうち新たに解決可能になったものを報告する
- update: manifest の ref を commit SHA へ再解決して lock の sources を書き直し、
  取得物をキャッシュへ置く。リモート契約の版の採用はこの瞬間に始まり、lock の
  差分としてレビューされる
- fetch: lock に記録された commit SHA と digest のとおりに取得し、検証してキャッシュへ
  置く(クリーンな環境の復元用。lock を書き換えない)
- gen / verify: 従来どおりネットワーク・環境変数・サブプロセスに触れない。gen は
  キャッシュ欠損時に fetch の実行を指示して停止し、勝手に最新版を解決することはない

取得は Web 標準の fetch() による HTTPS のみで行い、接続先は公開 GitHub の API と
raw コンテンツ配信(api.github.com / raw.githubusercontent.com)に固定する。
git コマンド等のサブプロセスは取得側でも使わない。

## verify の照合範囲

リモート契約は、キャッシュが無い状態(クリーンチェックアウト)では「配布コピー 対 lock」
と「manifest・lock の整合」を照合する。「正本 対 lock」と「conformance 対 lock」は、正本が
キャッシュにしか存在しないため、キャッシュがあるときのみ照合する(スキップは静かに行われ、
違反とは扱わない。完全照合が要る場面は fetch → verify と並べる)。ローカル契約は従来どおり
全照合を行う。配布コピーの照合はヘッダと本文 digest だけで成立し正本テキストを必要と
しないため、消費側の中核保証はネットワーク無しで完走する。専用の --offline フラグは
設けない。

## 初期スコープ

public GitHub のみ・認証なし・lock には commit SHA を必ず記録(manifest の ref は
tag / branch 可)・transitive 依存(取得した契約がさらに別の出典を要求すること)なし・
conformance script は実行せずデータとしてコピーするのみ。このスコープはブレストで
合意した範囲であり、これを超える縮小・拡大は改めて合意してから行う。

## スケール前提

この設計は「共有文書は少数(数個〜十数個)・テキストのみ・transitive なし」という前提の
上に立つ。source が数十個に増える、conformance ツリーが肥大するなどで前提が崩れたときのみ、
キャッシュのユーザーグローバル化(リポジトリ間共有)を再検討する。
