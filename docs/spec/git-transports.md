# 汎用 Git transport

## 目的

リモート source の正本を、GitHub.com だけでなく、GitLab、Forgejo、独自 Git
サーバーから取得できるようにする。

既存の `owner/repo` 表記は、従来どおり GitHub API を使う。SSH または HTTPS の
repository URL が指定された場合だけ、利用環境にインストールされた Git と
OpenSSH へ取得を委譲する。この経路を汎用 Git transport と呼ぶ。

利用者が普段 `git clone <repository URL>` できる環境では、同じ URL を `add` へ
渡すだけで登録・取得できることを利用体験の基準とする。

## repository の表記と取得方法

`vendor-manifest.yaml` の `repository` は、次の allowlist に従う。allowlist は、
受理する形だけを列挙し、それ以外を拒否する検査方法である。

| 表記 | 取得方法 |
| --- | --- |
| `owner/repo` | 従来の GitHub API |
| `ssh://...` | 汎用 Git transport |
| `user@host:path` 形式 | 汎用 Git transport |
| `https://...` | 汎用 Git transport |

transport は `repository` の表記から一意に決まるため、manifest に別の
`transport` 欄は置かない。

SSH の scp 風表記は検査後も入力どおり保存する。SSH の host alias や相対 path
には利用者の設定上の意味があるため、`ssh://` 形式へ自動変換しない。

次の入力は Git を起動する前に拒否する。

- ユーザー名・パスワード・tokenを埋め込んだ HTTP(S) URL
- 平文の `http://`
- `file://`
- ローカル file system の path
- 外部 command を transport として起動できる形式
- allowlist にない Git remote helper

平文 HTTP は今回の対象外とする。認証付き HTTP を含む危険許可は、必要になった
時点で別の要件として扱う。

## 認証と接続先の確認

汎用 Git transport では、ツール自身が認証情報を受け取らず、保存せず、request
へ載せない。

SSH の認証は SSH agent または利用者の秘密鍵へ委譲する。接続先の確認には
OpenSSH の `known_hosts` を使い、未知の host key を自動承認しない。

HTTPS の認証は Git credential helper へ委譲する。TLS 証明書の検証を無効化しない。

利用者が管理する system/global Git 設定と SSH 設定は trusted boundary に含める。
一方、取得対象 repository の local Git 設定は読まない。Git command の差し替え、
追加 Authorization header、trace、askpass などを実行ごとに注入できる危険な環境変数は
子 process へ渡さない。

GitHub API transport の `--token-stdin` は従来どおり GitHub の固定 host だけに
適用する。汎用 Git transport の認証には使用しない。

## 認証済み環境と CI

汎用 Git transport は、標準入力が対話端末かどうかにかかわらず常に非対話で実行する。
Git の terminal prompt と OpenSSH の対話認証を無効化し、子 process の標準入力を閉じる。
これにより、全実行を独立した detached process group に置き、timeout または容量超過時に
子孫を終了する。OS が process group の停止を確認できる場合は、一時 bare repository を
通常どおり削除する。確認できない場合は安全側に倒し、削除せずに保持する。

SSH agent、秘密鍵、既知の host key、保存済み credential helper など、通常の
`git pull` が入力なしで使える認証状態はそのまま再利用する。追加の username、password、
鍵の passphrase、host key 確認が必要なら入力待ちにせず失敗する。

初回認証や host key 確認は、利用者が通常の Git/OpenSSH を直接実行して済ませる。失敗時は
生の子 process 出力を転載せず、通常の Git で対象 repository の認証と接続確認を完了して
から再実行するよう案内する。ツール自身は認証情報を仲介しない。

同じ repository URL が別端末でも取得できることは保証しない。manifest と lock が
記録するのは取得対象と採用版であり、SSH鍵、credential、`known_hosts` などの接続設定は
各実行環境が管理する。

## command の境界

Git と network に触れるのは `add`、`update`、`fetch` だけとする。

`gen`、`verify`、`lint-selfcontain`、`self-test` は従来どおり network、environment、
subprocess に触れない。

汎用 Git transport は shell を介さず、固定された引数で Git を起動する。取得には
ツール専用の一時 bare repository を使う。bare repository は作業 tree を持たない
Git repository であり、checkout に伴う処理を避けられる。

取得では `--depth=1 --filter=blob:none --no-tags` に相当する最小取得を要求する。
checkout、hook、Git LFS の実体化、smudge filter、submodule の展開は行わない。
必要な通常 file の blob だけを Git object database から読む。

partial clone による取得量削減は、接続先 server が対応している場合の最適化であり、
厳密な通信量保証ではない。

## ref の解決と lock

`add` と `update` は、事前の問い合わせで見えた commit ではなく、実際に fetch できた
commit の object id を lock に記録する。その同じ commit tree から cache を作る。
ref の問い合わせ後に branch が動いても、lock と cache が別 commit を指す状態を
作らない。

`fetch` は lock の object id を直接取得する。server が object id の直接指定を拒否した
場合だけ manifest の ref を取得し、実際の object id が lock と完全一致することを確認する。

ref が別 commit へ移動していた場合や、lock の commit が取得不能な場合は停止する。
現在の ref へ黙って切り替えない。採用版を変更できる command は `update` だけである。

lock は取得内容の同一性を保証するが、origin server が commit を永久に保持・配信する
可用性は保証しない。

## Git object format

SHA-1 と SHA-256 の Git object format を扱う。

既存 lock で `objectFormat` がなければ SHA-1 と解釈する。SHA-256 repository では、
source の解決結果に次のように記録する。

```json
{
  "repository": "ssh://git@example.com/group/repository.git",
  "revision": "<64桁のobject id>",
  "objectFormat": "sha256"
}
```

commit と blob は、repository が使用する object format で検証する。

## resource limit

1 source に対し、次の既定上限を累積で適用する。

| 対象 | 上限 |
| --- | --- |
| ref解決、fetch、遅延blob取得、展開を含む実行時間 | 120秒 |
| 一時bare repositoryのdisk使用量 | 256 MiB |
| 展開する1 file | 1 MiB |
| 展開する全fileの合計 | 256 MiB |

blob はstreamとして読み、上限判定前に全量をmemoryへ載せない。

server が partial clone を無視した場合も同じ上限を適用する。ただし、監視間隔の途中に
発生するdisk使用量や通信量の瞬間的な超過までは厳密に保証しない。

上限の緩和は、実行者が command line で明示した場合だけ許す。manifest は上限を
緩和できない。

timeout、容量超過、または取得失敗では、Git、SSH、credential helperを含む detached
process group の終了を試みる。OS が停止を確認できる場合は、一時bare repositoryを通常どおり
削除する。確認できない場合は安全側に倒し、OS の一時ディレクトリ配下にある
`agentic-skill-git-` prefix の当該一時bare repositoryを削除せず保持する。どちらの場合も
既存cache、manifest、lockを変更せず、生の子 process 標準エラーを報告へ転載しない。保持物を
復旧するには、まず関連する process group が停止したことを確認し、その後、その正確な保持
ディレクトリだけを手動で削除する。停止確認後は、その正確なディレクトリだけを対象にした
再帰削除を許可するが、OS の一時ディレクトリの root や親ディレクトリを再帰削除せず、glob や
未解決の変数で対象を選ばない。

## error

汎用 Git transport では、Git、SSH、credential helperが出した生の標準エラーをツールの報告へ
転載しない。外部 command の出力には、credentialや内部接続設定が含まれる可能性があり、
未知の値を完全にredactすることはできないためである。

代わりに、ref解決、接続または認証、commit取得、object検証、timeout、容量超過のうち、
失敗した段階と安全な復旧案を報告する。

詳細が必要な利用者は、同じrepository URLへGit commandを直接実行して診断する。
