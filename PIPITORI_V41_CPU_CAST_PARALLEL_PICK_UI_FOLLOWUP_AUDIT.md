# ピピトリ v41 CPUキャスト・並行ピック発話・iPhone UI 追補監査

- 基準版: v40（`pipi_tori_online_parallel_pick_leave_ui_v40_20260816.zip`）
- 改修版: v41
- 監査日: 2026-08-16
- 対象: ユーザー提供の3画面と追加指定5項目

## 1. 結論

今回の5項目を実コードへ反映し、既存v40機能を維持したまま全回帰・実WebSocket完走をPASSした。

| 項目 | v41結果 |
| --- | --- |
| CPU 1～3 | `かももどき`、`ワクもどき`、`リクもどき`の名前・アイコンを固定 |
| CPU 4 | 観戦ホストから4席目を追加した時だけ、共有動物poolの名前＋一致絵文字を割当 |
| parallel pick後のCPUセリフ | 通常結果を含め、両lane完了後にちょうど1回発話 |
| iPhoneロビー | `プレイ参加中`を横書き固定し、狭幅では切替ボタンを次行へ配置 |
| ピック対象確定 | 完了laneを圧縮、必須ババ表示をstatus内へ統合、44px確定ボタンをsticky化 |
| ペア浄化 | 対象選択とスキップ対象を明記 |

## 2. CPU表示identity

### 2.1 v40での原因

v40の`createCpuSeat()`は全CPUに対して無条件に`assignCpuDisplayIdentity(room)`を呼んでいた。このため内部人格は3種類のままでも、表示名・絵文字は1席目からすべて動物identityへ置き換わっていた。

### 2.2 v41仕様

`nextCpuCharacter()`が返した人格が卓内で未使用なら、その人格が持つ固定identityを使う。

| 席 | 表示名 | アイコン／画像 | 内部人格 |
| --- | --- | --- | --- |
| CPU 1 | かももどき | 🦆／`kamomodoki.jpg` | kamomodoki |
| CPU 2 | ワクもどき | ✊🏻／`wakumodoki.jpg` | wakumodoki |
| CPU 3 | リクもどき | 📋／`rikumodoki.png` | rikumodoki |
| CPU 4 | 共有poolからランダム | 名前に対応する動物絵文字 | 3人格のいずれか（表示とは分離） |

3人格がすべて着席済みの場合だけ`assignCpuDisplayIdentity()`へ進む。4人目は人間player・spectatorを含む既存参加者と名前・絵文字が重ならない候補を優先し、`displayIdentityKey`で名前と絵文字の組を永続化する。再描画で再抽選されない。

CPU戦略・セリフ生成は従来どおり`cpuCharacter`を参照し、4人目の動物表示identityとは混同しない。

## 3. parallel pick完了後のCPUセリフ

### 3.1 根本原因

`parallelPickSummary()`は、次の重要結果だけを`important`としていた。

- シュート
- ババブタ
- マッド・ピッグ
- ペア浄化

両laneが通常カードだった場合は`important === null`となり、旧コードの`if(!important) return`で発話せず終了していた。これはtimer不発ではなく、通常結果を意図的に除外した分岐が原因だった。

### 3.2 修正

- 重要結果がない通常2ピックにも集約文を追加。
- 片方のlane完了時には発話しない。
- `primary`と`secondary`が`completed / skipped`になり、`finishParallelPickGroup()`へ到達した時だけ発話。
- `group.commentEmitted`で二重発火を防止。
- 通常結果でもCPUがいる場合は1回を保証。
- シュート時に演出開始直後へ先走っていた発話を廃止し、話者候補だけ保存してgroup完了時へ集約。
- event優先度はシュート → ババブタ → マッド → ペア浄化 → 通常ピック。

決定論的テストでは、1つ目のlane完了後はコメント増分0、2つ目のlane完了後は増分1、`eventKey === "pick"`を確認した。

## 4. iPhoneロビーの「プレイ参加中」崩れ

### 4.1 原因

狭幅用の共通CSS `.input,.btn{width:100%}`が、横並びの`.participant-role-actions`内ボタンにも適用されていた。ボタンが行幅を占有して左のstatusを極端に圧縮し、日本語が1文字ずつ縦に折り返されていた。

### 4.2 修正

- statusへ`white-space: nowrap`と横書きを明示。
- 通常幅ではボタンを`width:auto`、最大70%へ制限。
- 620px以下ではstatusと切替ボタンを1列gridで上下配置。
- ボタンは次行で100%幅となり、statusを圧迫しない。

## 5. ピック対象確定ボタン

### 5.1 原因

添付2画面の切れは、黄色い必須候補メッセージだけが原因ではない。次の3条件が重なっていた。

1. 完了済みprimary laneが人物・結果カードを含む通常高さのまま残る。
2. secondary laneに独立した大きい`ババブタは必須候補`ブロックが追加される。
3. ゲーム卓の`pick-mode`が固定高かつ`overflow:hidden`で、最下部の確定ボタンを切る。

### 5.2 修正

- laneへ`is-complete`、`is-target-selecting`、`is-pair-selecting`等のphase classを付与。
- iPhone縦で完了laneの人物列を隠し、結果表示を小型化。
- 必須ババ表示を独立ブロックからstatus内の小型chipへ統合。
- 文言を`ピック対象を確定`へ明確化。
- 対象カードrailを横スクロール・高さ上限112pxへ固定。
- 確定ボタンを44px以上、`position: sticky; bottom: 0`へ変更。
- parallel shell自身を安全な内側スクロール領域にし、卓外へ切り捨てない。
- 左右・下のsafe-areaを維持。

390×844、393×852、430×932はcompact layout budget上で直接収まる。320×568、375×667はカード可読性を落とさず、parallel shell内だけを短くスクロールでき、確定ボタンは下端へ保持する。

## 6. ペア浄化UI

parallel／middle OFF互換UIの双方を次の表現へ統一した。

- 上部: `ペア浄化対象を選んでください`
- 候補札: `この札と浄化`
- 下部: `ペア浄化をスキップ`
- action guide: `ペア浄化対象を選ぶ`／`同じ数字のカードを選ぶ／ペア浄化をスキップ`

サーバーmessageも同じ意味へ揃え、何をスキップするかを状態broadcast後も明確にした。

## 7. ルール説明監査

今回の画面修正時に、v40 UI内へ残っていた次の直列表現も検出した。

- `通常ピック後に2位...`
- `続けて2位→3位...`
- `1位→最弱に続いて...`
- `必殺技演出の後に追加ピック...`

すべて、1位↔4位と2位→3位が同時進行し、シュート演出中もsecondaryのstate処理が進む説明へ修正した。v41テストはこれら4つの古い表現が0件であることを検査する。

## 8. テスト変更

既存テストは削除・弱体化していない。仕様変更に合わせて次の期待値だけを強化した。

- CPU identity: 全CPU動物 → 固定3人格＋4人目だけ動物。
- parallel comment: `1 groupあたり0～1回` → CPUがいる通常groupでは`両lane完了後ちょうど1回`。
- UI: 横書きrole、compact lane、sticky確定、明確なペア浄化文言を追加。
- 新規`tests/v41_followup_regression.js`を追加。
- `npm run test:v41`を追加し、v40全5 suite＋v41追補を一括実行。

## 9. 実行結果

| コマンド／検査 | 結果 | 主な確認 |
| --- | --- | --- |
| `node --check server.js` | PASS | JavaScript構文 |
| `npm test` | PASS | 全既存回帰＋v41、589,824 rule combinations、1,536 gameplay runs |
| `npm run test:v41` | PASS | 固定CPU、4人目動物、発話時点、ロビー、確定、浄化文言 |
| `npm run test:ui` | PASS | mobile、layout、shoot、v40/v41 UI |
| `npm run test:rules` | PASS | rules、pick、shoot、得点、組合せ |
| `npm run test:smoke` | PASS | lobby → playing → finished、全4スート、pick target |
| `npm run test:reconnect` | PASS | 同じplayerId・13枚手札復元・復帰後play |
| `npm run test:resilience` | PASS | stale cleanup取消、切断手番fallback、同席復帰 |
| `npm run test:spectator` | PASS | viewer別privacy、spectator cleanup |
| `npm run test:lobby-repeat` | PASS | 反復CPU追加、room clear |
| `npm run test:fullgame` | PASS | 下記7シナリオ完走 |
| CSS parser／source integrity | PASS | duplicate ID 0、duplicate function 0、blocking alert 0 |

### 実ゲーム完走

| シナリオ | 結果 |
| --- | --- |
| 人間4・middle OFF | PASS |
| 人間4・middle ON | PASS |
| CPU4＋spectator | PASS |
| CPU4＋spectator・ババ移動 | PASS |
| CPU4・注目3ルールON・実シュート発射 | PASS |
| 人間3＋CPU1＋spectator host | PASS |
| 人間途中明示離脱 → CPU同席代打 → finished | PASS |

注目3ルール完走ではmiddle pick、強制ババ候補、装填→発射を同時に有効化し、シュートevent 1回を実観測した。途中離脱完走ではCPU replacementを実観測し、約84秒でfinishedと最終得点まで到達した。

## 10. Viewport監査

対象契約は320×568、375×667、390×844、393×852、430×932を含む。CSS構文解析、既存mobile/layoutモデル、v41 compact budget、safe-area、44px操作領域、bounded scroll／sticky actionを自動検査した。

この実行環境にはChromium実行ファイルおよびPython Playwright bindingが存在しなかったため、**実ブラウザ視覚監査は未実施**。実施したふりはしていない。添付3画面は原寸で目視し、各崩れを引き起こすDOM/CSS条件をソース上で特定している。

## 11. 品質・互換性

- v40の明示離脱、reconnect token無効化、一時切断復帰、host移譲を維持。
- `room.players`／`room.spectators`分離とviewer別手札privacyを維持。
- CPU-only自動ラウンド進行2.6秒を維持。
- parallel laneのpickId、stale拒否、独立pair cleanse、両lane完了条件を維持。
- card uniqueness、得点冪等化、round二重終了防止を全回帰で維持。
- middle OFFの既存1lane処理とペア浄化操作を維持。
- `node_modules`は更新ZIPに含めない。

## 12. 既知の制約

1. 320×568と375×667では、カードを44px未満へ縮小しないためparallel pick領域内に短い縦スクロールが必要。ページ全体ではなく専用shell内に限定し、確定ボタンを下端へ保持する。
2. 実ブラウザ／実iPhoneのpixel screenshot比較は上記環境制約により未実施。
3. 4人目CPUの動物identityは追加時にランダムだが、追加後は同じparticipant objectへ保存されるため再描画では変化しない。削除して新規追加した場合は再抽選してよい仕様。

以上。
