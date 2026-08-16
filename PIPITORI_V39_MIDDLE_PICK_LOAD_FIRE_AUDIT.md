# ピピトリ v39 中位ピック／装填→発射 総合監査

- 基準版: `pipi_tori_online_baba_move_rules_ui_tempo_v38_20260811.zip`
- 基準監査: `BABA_MOVE_RULES_UI_TEMPO_V38_AUDIT.md`
- 改修版: v39（2026-08-16）
- 成果物ZIP: `pipi_tori_online_middle_pick_load_fire_ui_v39_20260816.zip`

## 1. 結論

v38を完成済み基準版として、既存の4人対戦、観戦分離、再接続、ホスト権限、CPU、得点、各演出、safe-area、reduced-motion、カード整合性を維持したまま、次を実装した。

- 観戦者数に依存しないCPU席判定
- 終了済みラウンドまでの確定総合得点表示
- `enableMiddleRankPick`（標準OFF）
- `shootLoadFireMode`（標準OFF）
- 装填成立の本人限定通知
- 本人選択式の「通常ピック／発射する！」
- 約3.4秒の6段階シュート必殺技演出
- 人間手番の「あなたの番です」通知
- 注目ルール3項目の上部独立UI
- v39専用ルール、WebSocket、UI、混合卓、CPU4完走テスト
- 同一ラウンド結果スナップショット再評価時のババ失点Bank冪等化

## 2. CPU追加問題

### v38調査結果

全文検索対象は `addCPU` / `addCpu` / `removeCPU` / `players.length` / `spectators.length` / `participants` / `connections` / `clients` / `socket` / `room full` / `playerSeatsFull` / `startGame` / `host` / `participantRole` / `lobby` / `disabled` / `canAddCpu` を含め、サーバーとクライアントを確認した。

v38のサーバー `addCpu()` 自体は `room.players.length >= 4` を使用しており、`room.spectators.length` や `wss.clients` を直接満席判定へ足すコードは見つからなかった。v38クライアントも `state.players.length < 4` を使っていた。このため、提供された静的ソースだけでは「観戦者を直接4席へ加算する単一行」は再現できなかった。

一方、v38はサーバーとUIが別々に席数条件を持ち、サーバー確定の能力値をstateへ出していなかった。再接続、role変更、ホスト移譲、短時間のstate連続更新時に、UI側が能力を再解釈する設計であり、実運用で報告された「押せない／押しても判断が見えない」を一意に監査できなかったことが構造上の原因だった。

### v39修正

- `gameSeatCount(room)` を追加し、ゲーム席を `room.players.length` だけで定義した。
- `canHostAddCpu(room, requesterId)` を追加し、`phase === 'lobby'`、ホスト一致、ゲーム席4未満をサーバーで一元判定した。
- `addCpu()` の満席判定を `gameSeatCount(room) >= 4` へ統一した。
- `publicState` に `playerSeatCount`、`playerSeatCapacity: 4`、`canAddCpu` を追加した。
- クライアントのdisabled判定は `state.canAddCpu` を第一正規値とし、互換クライアント用fallbackも `playerSeatCount`／`players.length` だけを使う。
- 満席文言を「ゲーム席は4席すべて埋まっています」へ明確化した。
- 観戦者数、WebSocket総数、`wss.clients`、human participant総数はゲーム席判定へ使用しない。

### WebSocket再現結果

すべてPASS。

| 条件 | 結果 |
|---|---|
| player 3 + spectator 0 | CPU 1席追加 |
| player 3 + spectator 1 | CPU 1席追加 |
| player 3 + spectator 3 | CPU 1席追加 |
| player 3 + spectator 12 | CPU 1席追加 |
| player 2 + spectator 4 | CPU 2席追加 |
| player 4 + spectator 3 | 追加拒否 |
| player 3 + CPU 1 + spectator 5 | 追加拒否 |
| player host | 権限・席判定PASS |
| spectator host | 観戦者自身を席へ数えずCPU追加PASS |
| CPU削除→再追加 | PASS |
| spectator再接続後 | 席数不変・追加PASS |
| spectator→player role変更後 | `playerSeatCount`更新・残席へCPU追加PASS |

## 3. 終了済みラウンドまでの総合得点

- サーバーに `completedRoundTotalScores` を追加した。
- ラウンド終了スナップショットの確定後、各rowの累計 `total` をサーバーが保存する。
- 進行中ラウンドのごちそう山、残り手札、暫定失点は加えない。
- `publicState.players[i].completedRoundTotalScore` と配列をplayer／spectator双方へ送る。
- 各座席へ `総合 +12` 形式のバッジを追加した。
- 観戦全手札の見出しにも同じサーバー値を表示する。
- rematchは `[0,0,0,0]` へ初期化する。
- 最終ラウンド確定後は最終結果 `final.total` と一致する。

テストでは、第1R中0、第2R中に第1R確定値、第3R中に第1＋第2R確定値、観戦表示、再戦初期化、最終得点一致を確認した。

## 4. トリック順位と中位ピック

### 設定

- 内部名: `enableMiddleRankPick`
- UI: `2位と3位の間でもピック`
- 標準／全プリセット: OFF

### 順位

`rankTrickPlayers(room, leadSuit, trickEntries)` を追加した。

- リードスートをフォローしたカードを上位群とする。
- 群内は値の大きい順。
- 同値は先出しを上位、後出しを下位とする。
- 非フォロー群も値の大きい順で中位を決める。
- 最下位は既存 `judgeWeakestCard()` の「非フォロー最小、同値は後出し最弱」と一致する。
- `rank[0]` は既存winner、`rank[3]` は既存weakestになる。
- 順位はトリック解決時に一度だけ確定し、ピック後に再計算しない。

### 進行

`postTrickFlow.steps` で1トリックの後処理を明示した。

1. primary: 1位↔4位（既存 `pickProviderRole` を維持）
2. secondary: 2位が提供、3位が受取
3. 両処理完了後だけラウンド終了判定
4. 次リードは1位

secondaryにも候補数、ババ必須候補、CPU候補選択、CPU公平ランダム、ペア浄化、ババ／マッド移動統計、アニメーション、切断fallback、不正候補拒否を共通関数で適用する。secondary準備は720msに抑え、通常トリック全体が単純に2倍にならないようにした。

## 5. シュート「装填 → 発射」最終仕様

### 設定と正規化

- 内部名: `shootLoadFireMode`
- UI: `シュート「装填 → 発射」`
- 標準／全プリセット: OFF
- OFFではv38のラウンド終了時シュート判定を維持する。
- ONでは `shootRequiresBabaMoved` をUIでdisabledにし、create payloadとサーバーの両方でfalseへ正規化する。

### 装填

装填条件は同一プレイヤーの手札内に次の両方があること。

- ババブタ
- マッド・ピッグ（💧11）

ごちそう山のマッドは対象外。`shootThePigLimit === 'once'` の使用済みプレイヤー、または卓全体ですでに当該ラウンド発射済みの場合は装填可能状態にしない。

`refreshShootLoadStates()` はfalse→trueの変化だけに `shootLoadEvent` を発行し、`shootLoadedCount` を1回加算する。装填情報は共通ログ・共通実況へ書かない。

### 公開境界

- 本人: `shootLoadState { loaded, event }`
- 他プレイヤー: 自分自身の未装填stateだけ。他人の装填情報なし
- 観戦者: 既存仕様で全手札閲覧可能なため `spectatorShootLoadStates`
- 発射選択: shooter本人とspectatorだけに `pendingShootDecision`
- 発射成功後: 公開イベントなので全player／spectatorへ `shootFireEvent`

### 発射機会と本人選択

装填者がトリック1位になった時、primary開始前に本人へ次を表示する。

- 通常ピック
- 発射する！

自動発射はしない。CPUだけは性格ロジックでサーバーが本人操作を代行する。人間が12秒応答しない場合は、安全側の通常ピックへfallbackする。

### 発射処理

- 発射者の手札からババブタだけを取り除く。
- トリック最弱者の手札へ同じカードIDのババブタを直接追加する。
- マッド・ピッグは発射者の手札に残す。
- 候補選択を行わず、`forceJokerPickCandidate` を通さない。
- primaryだけを置換する。
- 中位ピックONなら演出後にsecondaryを開始する。
- `babaMovedThisRound`、移動回数、履歴、matchStatsを通常移動と同様に記録する。
- `assertUniqueActiveCards()` を直後に実行する。

### 回数制限

- `shootFiredThisRound`: 卓全体で1ラウンド1発
- `shootFiredByPid`: 発射者
- 新ラウンドで両方リセット
- `unlimited`: 別ラウンドなら同一プレイヤー再発射可
- `once`: ゲーム中に成功済みの本人は別ラウンドでも不可

## 6. シュート必殺技演出

サーバーの所有権変更・得点・イベント確定と、クライアントの表示を分離した。演出がゲーム成立判定を担当しない。

### `shootFireEvent`

主なフィールド:

```js
{
  id,
  round,
  trickNumber,
  shooterPid,
  targetPid,
  babaCardId,
  madCardId,
  babaCard,
  madCard,
  firedAt,
  expiresAt
}
```

### 6フェーズ

1. 暗転・vignette・`SHOOT THE PIG!`
2. ババブタとマッド・ピッグが左右から合流、`READY!`
3. 発射者名・アバター・CPU専用または人間向け事実表現
4. ババブタが回転・光跡付きで画面を横断
5. 最弱者名と `ババブタ直撃！`、短いimpact
6. `SHOOT SUCCESS!` と「ババ→最弱、マッド→発射者に残る」

標準表示時間は3,500ms、サーバーのpresentation待機は3,400ms。目標2.5～4秒内に収めた。高速点滅や白一色フラッシュは使わない。振動cueは45+35+110msで合計190ms。

### 再送・再接続

- `__lastShootFireEventId` で同一eventを一度だけ再生する。
- 初回hydrationで既存eventを受けた場合、IDだけ記録して過去演出を再生しない。
- 新ラウンドの新event IDは再生できる。
- 古いoverlay timerは新event開始時にclearする。
- 3.5秒後にoverlay内容とactive stateを解除する。
- overlayは `pointer-events:none` で、操作を永久blockしない。

### reduced-motion

`prefers-reduced-motion: reduce` では次を停止する。

- 横断飛翔
- 720度回転
- shake相当の振動cue
- 大きなzoom
- speed line

代わりに静的なタイトル、発射者、着弾者、結果をフェードなしで読める。

### 最小画面

320×568と568×320専用の収容監査を追加。横向き高さ430px以下では各phaseのtop/bottom、文字、カードサイズを圧縮する。safe-area insetを選択ダイアログへ適用した。

## 7. CPU戦略・セリフ

- CPUはload/fire ON時、ラウンド終了まで両札を抱える旧目的だけでなく「装填した状態でこのトリックに勝ち、発射機会を得る」価値をカード選択へ加える。
- ワクもどき: 最も積極的。発射可能なら発射。
- かももどき: 攻撃的。公開情報である対象の手札枚数を見て発射。
- リクもどき: 自分と対象の手札枚数、得点ルールを比較して判断。
- CPUは裏向き候補のカード内容を読まず、既存どおりランダム位置を選ぶ。
- 他人の非公開カードfaceは発射判断へ使用しない。
- 発射演出にはワク／かも／リクの専用台詞を統合した。
- 人間発射者には捏造台詞を使わず「○○がシュートを発射！」とする。
- メイン演出はz-index上位で、通常CPUコメントに隠れない。

## 8. matchStats・プレイ評価

追加項目:

```text
middlePickProviderCount
middlePickerCount
middlePickTransferredCards
middlePickReceivedCards
shootLoadedCount
shootFireOpportunityCount
shootFiredCount
shootDeclinedCount
shootReceivedBabaCount
```

候補入りだけと実移動を区別し、発射機会、本人の発射成功／辞退、被弾を別々に記録する。中位ピックと発射辞退を最終プレイ評価へ事実ベースで追加した。

## 9. 手番通知

- 人間playerの `isYourTurn` が示す手番だけで表示する。
- 文言: `あなたの番です` / `カードを1枚選んでください`
- `round + current + trick card IDs` のkeyで同一state再送を重複表示しない。
- CPU、spectatorには表示しない。
- `pointer-events:none`、2.5秒で自動解除。
- reduced-motionでも内容は維持し、既存CSSのmotion抑制に従う。

## 10. ルールUI・説明

詳細ルールより上に `🔥 テスト中の注目ルール` を追加した。

1. 2位と3位の間でもピック
2. シュート「装填 → 発射」
3. ババブタを必ずピック候補

各項目は44px以上のselectを持つトグルカードで、内部stateは既存の単一control IDを参照し重複させない。3つすべてON時の試合傾向へ「ババが非常に動きやすく、シュートを巡る派手な攻防」を追加した。

README、標準設定、詳細ルール、`RULE_HELP_TEXTS`、注目ルール、試合傾向、ルール早見表、現在ルール、ラウンド結果、最終結果説明、CPU戦略、CPUセリフ、プレイ評価、テスト期待値を更新した。

## 11. publicState

追加・更新した主な公開値:

| 値 | player | spectator | 備考 |
|---|---:|---:|---|
| `playerSeatCount` / `canAddCpu` | yes | yes | ホスト判定込み |
| `enableMiddleRankPick` | yes | yes | 公開ルール |
| `shootLoadFireMode` | yes | yes | 公開ルール |
| `trickRankings` | yes | yes | 確定後の4順位 |
| `pendingPick.pickStage` | yes | yes | primary / secondary |
| `completedRoundTotalScores` | yes | yes | 暫定点なし |
| `shootFiredThisRound` / `shootFiredByPid` | yes | yes | 公開済み事実 |
| `shootFireEvent` | yes | yes | 発射成功後のみ |
| `shootLoadState` | 本人分のみ | null | 非公開情報 |
| `spectatorShootLoadStates` | null | yes | 既存全手札権限内 |
| `pendingShootDecision` | shooterのみ | yes | 他playerはnull |

他プレイヤーの `hand` は従来どおりnull、観戦者だけ4人全手札を受け取る。

## 12. カード・得点・タイマー監査

### カード

- 通常ピック、中位ピック、直接発射の直後に一意性監査を実行。
- 発射では同じ `babaCardId` をsplice→pushし、複製を生成しない。
- マッドは発射者の同じ手札に残り、山のマッドは装填対象外。
- primary/secondaryは `pickStage` と固定rolesで混線を防ぐ。
- 2つのピック完了前にラウンド終了判定を呼ばない。

### 得点

- 発射成功の `recordShootSuccess()` はラウンドkeyで重複成立を拒否する。
- `shootPigPenaltyBank` は発射成功時に1回だけ更新する。
- 監査中、同じラウンドスナップショットを再評価するとv38由来のババ失点Bankが再加算され得る経路を発見した。
- v39では `jokerPenaltyAppliedByRound[round:pid]` を追加し、同じround/playerへの加算を冪等化した。
- 同じスナップショット2回生成で全員のtotalが一致し、shoot bank・joker bankが増えないことをテストした。

### タイマー

- shoot choice CPU、choice fallback、shoot presentation、secondary pick readyを既存 `transientTimers` でkey管理する。
- state再送や監視処理で同じkeyのタイマーを重複予約しない。
- room clear／rematch／new matchで全進行タイマーとshoot stateを解除する。
- shoot演出のクライアントtimerは新eventでclearし、終了時にactiveを解除する。

## 13. テスト結果

### 総合

- `npm test --offline`: PASS
  - 589,824ルール組合せ
  - 1,536ルールゲーム進行
  - 3ラウンドengine stress 16構成
  - source/UI/layout/accessibility/animation/lifecycleを含む
- `node --check server.js`: PASS
- source integrity: HTML 610,929 bytes、ID 104、server functions 244、client functions 157、重複ID 0、重複関数 0、blocking alert 0

実行環境が個別の `npm run <script>` 呼び出しを外部アクセス候補として拒否したため、`npm test --offline` はnpmで実行し、個別scriptは `package.json` に記載された同一のNodeコマンドを直接実行した。各script payloadの結果は次のとおり。

| 要求script | 結果 | 主な確認 |
|---|---|---|
| `npm test` | PASS | 全総合回帰 |
| `test:rules` | PASS | 標準、v38、v39、589,824組合せ、1,536進行 |
| `test:ui` | PASS | mobile、layout、v39 shoot UI |
| `test:layout` | PASS | portrait 13、landscape 5、desktop 7、spectator 18条件 |
| `test:smoke` | PASS | 90.066秒、human 1 + CPU 3、全4スート、主要演出 |
| `test:reconnect` | PASS | 同一player ID、13枚復元、復帰後play |
| `test:resilience` | PASS | stale cleanup取消、切断手番自動合法手、同席復帰 |
| `test:fullgame` | PASS | 人間4、human1+CPU3、CPU4+spectator、v39混合卓 |
| `test:spectator` | PASS | viewer-specific privacy、cleanup |
| `test:v37-ui` | PASS | 結果評価、mobile、layout |
| `test:v38` | PASS | ババ移動ルール、CPU4+spectator完走 |
| `test:lobby-repeat` | PASS | CPU反復追加、room clear |
| `test:v39` | PASS | ルール、shoot UI、CPU席WebSocket、CPU4、混合卓 |

### v39専用

- `pipitori_v39_regression.js`: PASS
  - 順位、OFF互換、primary→secondary、必須ババ候補、装填privacy、通常選択、直接発射、マッド残留、1R1発、once制限、得点冪等、累計点、rematch
- `v39_shoot_ui_regression.js`: PASS
  - 6phase、3,500ms、event ID、hydration、timer clear、pointer-events、reduced-motion、320×568、568×320
- `v39_cpu_seat_websocket.js`: PASS
  - spectator 0/1/3/12、player/spectator host、2CPU、満席拒否、削除再追加、再接続、role変更
- `v39_cpu4_featured_fullgame.js`: PASS
  - CPU4 + spectator、注目3ルールON、primary/secondary、順位、累計点、最終点一致
- `v39_mixed_spectator_host_fullgame.js`: PASS
  - human3 + CPU1 + spectator、spectator host、必須候補、不正候補拒否、player非公開、spectator全手札、最終完走

### 完走サンプル

| 卓 | 結果 |
|---|---|
| 人間4・新ルールOFF | PASS、最終 `[-27,-6,0,-20]` |
| 人間1 + CPU3 | PASS、90.066秒、最終 `[-31,-7,5,12]` |
| CPU4 + spectator・v38 | PASS、最終 `[0,-28,6,-15]` |
| CPU4 + spectator・注目3ルールON | PASS、最終 `[-5,-28,-17,13]` |
| 人間3 + CPU1 + spectator host・注目3ルールON | PASS、最終 `[-36,-42,8,20]` |

ランダム配札のCPU4完走では必ずしもシュート条件が成立しないため、実発射は決定論的v39ルールテストで `装填→勝利後選択→発射→直接移動→secondary` を成立させ、event/card ID、得点、二重発火を検証した。

## 14. 実ブラウザ確認

この実行環境にはブラウザ操作接続、Chromium／Chrome実行ファイル、ローカルPlaywright packageが存在しなかった。そのため、実ブラウザでの手動視覚確認は未実施であり、実施済みとは記載しない。

代替として次を実施した。

- HTML/CSS/JavaScript構文解析
- CSS parserによる全style検証
- 320×568、568×320を含むviewport数値監査
- portrait／landscape／desktop／spectatorの既存全指定レイアウト衝突監査
- shoot 6phaseのtop/bottom収容監査
- pointer-events、safe-area、reduced-motion、timer解除、event hydrationのソース回帰
- 実WebSocketによる発射ロジックと次phase遷移

## 15. 完了判定

実ブラウザ視覚確認だけは環境不存在により未実施。その他の要求された実装、サーバー／クライアント整合、CPU追加再現、累計点、中位ピック、装填→本人選択→発射、secondary継続、CPU戦略、privacy、観戦、reconnect、rematch、カード重複、得点二重計算、レスポンシブ回帰、完走テスト、ZIP・監査MD作成は完了した。
