# ピピトリ v40 明示離脱・CPU identity・観戦安定化・並行ピック・UI 総合監査

- 基準版: `pipi_tori_online_middle_pick_load_fire_ui_v39_20260816.zip`
- 基準監査: `PIPITORI_V39_MIDDLE_PICK_LOAD_FIRE_AUDIT.md`
- 改修版: v40（2026-08-16）
- 成果物: `pipi_tori_online_parallel_pick_leave_ui_v40_20260816.zip`

## 1. 結論

v39を完成済み基準版として、4人ゲーム、人間／CPU混在、CPU4、観戦者ホスト、player／spectator state分離、再接続、role変更、room clear、rematch、3 CPU人格、Spotlight、matchStats、確定累計得点、ババ移動、候補絞り、装填→発射、1ラウンド1発、カード一意性、得点冪等性を維持したまま、次を実装した。

- player／spectatorの明示的な部屋離脱と、サーバー側resume identity無効化
- ゲーム中player離脱時の同一seat・同一手札・同一得点を保つCPU代打
- 接続済みplayer、次にspectatorへのホスト移譲
- 4人目を含む全CPUの永続的な動物表示identity
- CPUの表示identityと3人格ロジックの分離
- 観戦CPUコメントのevent ID差分描画
- CPU4卓のラウンド結果2.6秒自動進行
- `parallelPickGroup`によるprimary／secondaryの真正な並行state
- `groupId + pickId`単位の操作、timer、fallback、pair cleanse
- 2レーン完了後だけの次トリック／ラウンド終了判定
- parallel pick由来CPUコメントをgroup完了時最大1回へ集約
- 縦画面2段、横画面／PC 2列のparallel pick UI
- ロビー、ゲーム、観戦の情報優先度・タップ対象・差分描画改善
- v40専用回帰、実WebSocket完走、全viewportレイアウト監査

主要自動テストはすべてPASSした。実ブラウザ視覚監査だけは、実行環境にChromium、Playwright、Seleniumが無いため未実施である。実施したふりはしていない。

## 2. 変更ファイル

### 実装

- `server.js`
- `public/index.html`
- `package.json`

### 新規テスト

- `tests/intentional_leave_v40_regression.js`
- `tests/intentional_leave_fullgame_v40.js`
- `tests/cpu_identity_dialogue_v40_regression.js`
- `tests/cpu_only_round_advance_v40_regression.js`
- `tests/parallel_middle_pick_v40_regression.js`
- `tests/v40_ui_lifecycle_regression.js`

### 仕様変更に合わせた既存テスト更新

- `tests/pipitori_v39_regression.js`: middle ONの期待値を直列pendingPickからparallel groupへ更新
- `tests/v39_mixed_spectator_host_fullgame.js`: parallel操作へ`pickId`を追加
- `tests/interaction_accessibility_regression.js`:単一global pick timer前提をlane scoped timer前提へ更新
- `tests/four_human_completion_smoke.js`: middle OFF／ONの両方を完走可能にし、lane操作へ`pickId`を追加

既存テストの削除、弱体化は行っていない。

## 3. 明示的離脱

### 3.1 一時切断との違い

| 状態 | クライアント | サーバー | 復帰 |
|---|---|---|---|
| 一時切断 | reconnect情報を保持し、既存retryを継続 | participant、seat、resume tokenを保持 | 同じidentity／seatへ復帰 |
| 明示離脱 | `intentionalLeave=true`、retry停止、localStorageとresume情報を削除 | `leaveRoom`でparticipantを削除またはCPU置換し、旧tokenをnull化 | 旧identityへ復帰不可 |

`saveReconnectInfo()`、`scheduleReconnect()`、WebSocket `close`、`online`、`pageshow`は`intentionalLeave`を確認する。明示離脱後のclose競合でもauto reconnectを開始しない。

オフライン中はクライアントだけで離脱済みにせず、「通信復旧後に再度離脱」を案内する。サーバーへ無効化commandを届けられないのにlocalStorageだけ消す不整合を避けるためである。

### 3.2 UI

- ロビーの二次操作位置に「部屋から離脱」
- ゲーム／観戦HUDに44px以上の「離脱」
- ブラウザ標準`confirm()`を使わない`<dialog>`モーダル
- 文言にauto reconnectを行わないことと、ゲーム中seatがCPUへ引き継がれることを明記
- モーダルをロビーDOM外のトップレベルへ配置し、`gameplay-mode #lobby { display:none }`中も表示可能にした

### 3.3 WebSocket schema

要求:

```json
{ "type": "leaveRoom" }
```

成功応答:

```json
{
  "type": "leftRoom",
  "code": "ABCD",
  "participantRole": "player",
  "reason": "intentional"
}
```

サーバーはrequester WebSocketとparticipantの対応を再検証し、別画面へ引き継がれた古い接続からの離脱を拒否する。

### 3.4 ロビー離脱

- player: `room.players`から削除し、席を解放
- spectator: `room.spectators`から即時削除
- host離脱: 接続済みplayerを優先し、次に接続済みspectatorへ移譲
- 人間participantが0なら既存room cleanupへ移行

### 3.5 ゲーム中player離脱

離脱者を切断中humanとして残さず、同じ配列indexへ`createCpuSeat(room, participant)`のCPU代打を置く方式にした。

維持する値:

- seat index
- `hand`と全card ID
- `scorePile`
- `pairs`
- 確定得点bank
- Joker／Shoot penalty bank
- shoot使用round
- `matchStats`
- out状態

無効化する値:

- human participant ID
- resume token
- WebSocket
- disconnected timestamp

カードの再配布や再生成はしない。並行pick中の離脱でも、該当laneはCPU／fallbackで進み、他laneを止めない。実完走テストでは人間1＋CPU3から人間が途中離脱し、CPU4へ置換後、最終得点まで107,907msで完走した。

### 3.6 host移譲と人間0卓

`humanParticipants()`がplayersを先、spectatorsを後に返すため、移譲優先順位は要求どおりである。CPUをhostにはしない。接続済み人間が0でも、進行中CPU卓はcleanupで消さず完走させる。

### 3.7 再参加

明示離脱済みの旧player ID／resume tokenは`findReconnectCandidate()`で見つからない。本人がroom codeを入力して`join`すれば、新しいparticipant IDと新しいresume tokenを持つ参加者になる。旧seatへの自動復帰は行わない。

## 4. CPU表示identity

### 4.1 `CPU3`の根本原因

v39はCPU人格配列が3件だけで、4人目追加時に次のfallbackを使っていた。

```js
{ key: `cpu-${uid()}`, name: `CPU${room.players.length}`, avatar: '🐷' }
```

観戦者ホスト＋player 0からCPUを4席追加すると、4席目追加前の`room.players.length`が3なので、表示名が`CPU3`になった。

### 4.2 v40方式

既存の人間用`HUMAN_ANIMAL_IDENTITIES`を唯一の動物名／emoji対応表として再利用し、重複定義を作らなかった。

`assignCpuDisplayIdentity(room)`はroom内のplayer／spectatorが使用中の名前とemojiを確認し、両方未使用の組を優先する。CPU seat生成時に以下を保存する。

```js
{
  name,
  avatar,
  displayIdentityKey,
  cpuCharacter
}
```

- `name`／`avatar`: 卓上表示用の一致した動物identity
- `cpuCharacter`: かももどき／ワクもどき／リクもどきの判断人格

人格はroom内の使用数が少ないものを選んで均等化し、4人目以降は3人格を再利用する。表示identityは人格名や人格画像と混同しない。

identityはplayer objectへ保存するため、state再送、再描画、reconnect、rematchで変化しない。CPU削除→追加は新しいseatなので再抽選を許可する。ゲーム中human離脱のCPU代打も新しい表示identityを得る。

WebSocketテストでは、観戦者ホストから追加したCPU4人が例として`子ヒツジ 🐑`、`子サル 🐵`、`子イヌ 🐶`、`子パンダ 🐼`のような重複なしの一致ペアとなり、`CPU3`を含む`CPU数字`表示が0件であることを確認した。

## 5. CPUコメントちらつき

### 5.1 v39の原因

v39の`renderSpectatorView()`はstateを受信するたびに、次を無条件で`innerHTML`再代入していた。

- `spectatorTrick`
- `spectatorPickFlow`
- `spectatorHands`
- `spectatorCommentary`

コメント内容が同一でも`.spectator-comment` DOMが破棄・再生成され、CSS animation／transitionの初期状態が再適用された。iPhone縦画面ではstate broadcast、viewport変動、カード進行が密になるため、消去→同文再表示に見えやすかった。`visualViewport`やsafe-area自体は根本原因ではなく、無条件DOM再生成が主因だった。

### 5.2 event IDと差分更新

- サーバーの各commentへimmutableな`id`を付与
- 観戦コメントDOMの`data-comment-event-id`と受信event IDを比較
- 同一eventなら`innerHTML`、class、animationを変更しない
- event変更時だけ内容を更新
- trick、pick flow、4手札も内容keyが変わった時だけ再描画
- 通常player側コメントもevent ID＋expiry keyで差分化

`priority`、`minimumVisibleUntil`、`expiresAt`は維持した。同一eventの大量state broadcastでDOM identity、opacity、animationが変わらず、event変更時だけ置換されることをテストした。古いeventは`expiresAt`後に削除するため、長時間残留もしない。

## 6. CPU-onlyラウンド自動進行

### 6.1 v39の遅延原因

v39は全卓共通の`ROUND_END_AUTO_CONTINUE_MS = 45,000`だけを使用した。spectatorはゲーム操作を拒否されるため、CPU4＋spectatorでは誰も`continueRound`できず、45秒fallbackまで待つ構造だった。

### 6.2 v40方式

```text
cpuOnlyRoom = player 4席すべてCPU
CPU_ONLY_ROUND_END_AUTO_CONTINUE_MS = 2600
human playerが1人以上 = 既存45秒fallback
```

CPU-onlyではround resultを表示後、サーバーの`cpu-only-next-round-${round}` taskが2.6秒で`beginNextRound()`する。state監視側にも同じhuman count判定のfallbackを持つ。spectator数、visibility、acknowledgement、入力は進行条件に入れない。

CPU4＋spectatorの複数round完走、2.6秒advance、人間卓45秒維持を自動テストした。

## 7. Parallel Middle Pick

### 7.1 v39直列構造

v39は`postTrickFlow.steps`を持つが、`room.pendingPick`は1件だけだった。primary完了後に`flow.index`を進め、secondaryの`beginPickStep()`を呼んでいた。このため候補選択、CPU待機、結果表示、pair cleanse、コメントが直列化されていた。

### 7.2 v40 state

middle OFFは従来どおり`pendingPick` 1件。middle ONだけ次を正とする。

```js
parallelPickGroup = {
  groupId,
  trickId,
  winnerPid,
  createdAt,
  primary: {
    pickId, groupId, pickStage: 'primary', status,
    pickProviderPid, pickerPid,
    targetCandidateIds, mandatoryCandidateIds,
    pickOrderIds, result, pairChoice
  },
  secondary: {
    pickId, groupId, pickStage: 'secondary', status,
    pickProviderPid, pickerPid,
    targetCandidateIds, mandatoryCandidateIds,
    pickOrderIds, result, pairChoice
  }
}
```

`startParallelPickGroup()`は1回の同期処理内で両laneを作成する。テスト上のcreatedAt差は最大5ms以内である。primary human待ち＋secondary CPU完了、secondary human待ち＋primary CPU完了、両CPU、両humanを許可する。

### 7.3 command schemaとstale拒否

```json
{ "type": "pickTargets", "pickId": "pick-primary-...", "cardIds": ["..."] }
{ "type": "pick", "pickId": "pick-secondary-...", "index": 0 }
{ "type": "pairChoice", "pickId": "pick-primary-...", "cardId": "...", "skip": false }
```

parallel group中は`pickId`無しを拒否する。`pickById()`は現在group内の完全一致laneだけを返し、completed／skipped lane、不正ID、前trickのIDを拒否する。middle OFFの旧単一pickは互換のためpickId省略も受け付ける。

### 7.4 lane独立処理

各laneが独立して保持するもの:

- provider候補選択
- picker選択
- `pickTargetCount` 0／1／2
- mandatory Joker candidate
- ready時刻
- result
- pair cleanse選択
- disconnect fallback
- CPU target／pick／pair timer

primaryとsecondaryは4順位から別rolesを確定するが、「別playerだから安全」と仮定せず、各移動直後とgroup完了時に`assertUniqueActiveCards()`を実行する。

### 7.5 timerとstale event

timer keyは少なくとも`groupId + pickId/token`を含む。

- `cpu-target-${token}`
- `pick-ready-${token}`
- `cpu-pick-${token}`
- `cpu-pick-failsafe-${token}`
- `cpu-pair-${pairToken}`
- `pick-finish-${groupId}-${pickId}`
- `pick-finish-failsafe-${groupId}-${pickId}`

すべてroomの`transientTimers: Map`で管理し、同じkeyの重複予約を抑止する。callbackはphase、group所属、pick object、tokenを再検証してから作用する。前trick secondary timerが次trick primaryへ作用しない。

### 7.6 group完了とround end

terminal条件は両laneが`completed`または`skipped`であること。片lane完了では「もう1つのレーンを待っています」とstateを更新するだけで、通常手番へ戻さない。

両lane terminal時だけ、次を1回実行する。

1. group finalized guard
2. card uniqueness監査
3. group要約CPUコメント候補
4. `parallelPickGroup`／`pendingPick`解除
5. `finalizePostTrick()`
6. round end判定またはwinnerをnext leaderへ設定

二重round end、二重score、二重matchStats、二重next trickを防ぐ。

### 7.7 CPUコメント最大1回

parallel lane内では既存の個別`cpuPickLine`／Spotlight commentを発火しない。group完了時に2結果をまとめ、次の優先順位で最大1件だけ選ぶ。

1. shoot
2. ババブタ移動
3. マッド・ピッグ
4. pair cleanse
5. 通常pickは原則無言

`group.commentEmitted`でも二重発火を防ぐ。回帰テストは1 group由来comment `<= 1`を必須にした。

### 7.8 装填→発射との整合

winnerが装填済みならprimary laneを`shootDecision`として作成し、secondary laneは同時に通常開始する。発射時はprimaryだけ`presenting`→`completed`とし、secondary state処理は止めない。UIはshoot overlayを視覚最優先にするが、secondary lane stateを失わない。発射辞退なら同じprimary `pickId`をactiveへ戻す。

### 7.9 reconnect／disconnect

publicStateにviewer別`parallelPickGroup`を含めるため、再接続者は現在group、各laneのstatus、本人が操作可能な未完了laneを復元できる。完了laneは操作不可。不通humanに対する候補、pick、pair cleanse fallbackはそのlaneだけを進め、他laneへreturnしない。

### 7.10 公開範囲

- 全員: group ID、pick ID、roles、status、候補枚数、結果
- provider本人: 未確定候補のselectable card IDs、mandatory IDs
- picker本人: pair cleanse候補内容
- 他player: 上記非公開card IDs／候補faceを受け取らない
- spectator: 既存権限どおり4人全手札と両lane進行を閲覧するが、`canOperate=false`

### 7.11 テンポ測定

productionのv39と同じprepare／result timing定数を使い、CPU4の48トリック相当（通常、pair、mad、babaの結果組合せ）を測定した。

| 処理モデル | 平均後処理時間 |
|---|---:|
| v39相当: primary完了後にsecondary開始 | 9,220ms |
| v40: 両lane同時開始、遅いlaneを待つ | 5,683ms |

短縮は38%。これはtimerを短く見せた値ではなく、同じproduction timingを「合計」から「最大値」へ変えた並行state効果である。

実WebSocketの人間4完走では、参考値としてmiddle OFF 51,286ms、middle ON parallel 42,050msだった。カード順とpair発生が異なるため直接性能比較値には使わず、停止しない完走確認として扱う。

## 8. UI刷新

### 8.1 情報設計

- HUD: round、turn、lead、connectionを常時優先
- player hand dock: 常時到達可能
- event: trick result、parallel pick、shoot、baba、pairを卓中央の一時優先表示
- CPU comment／rules／log: 補助層
- spectator: `観戦中`badgeを常時表示し、操作buttonを出さない
- leave: 誤操作しにくいsecondary／HUD位置だが、探せば即時到達

枠線や発光を増やさず、暗色、カードゲーム感、CPU個性を維持した。glass／blurはモーダルbackdrop等の限定箇所だけに留めた。

### 8.2 parallel UI

- 縦画面: primary上段、secondary下段
- 横／PC: 2列
- 上段見出し: `🏆 1位 ↔ 4位`
- 下段見出し: `🥈 2位 → 🥉 3位`
- 本人laneだけ候補、pick、pair操作を有効化
- 他laneは候補選択中／pick中／pair cleanse／完了をread-only表示
- spectatorは両laneを同時表示し、操作なし
- primary／secondaryのcard flight classを分け、別領域と90msの視覚差で衝突を抑制

### 8.3 mobile／safe-area／accessibility

- 操作対象は最小44px
- safe-area insetを既存dock、overlay、modalと整合
- 540px以下はpadding、カード幅、補助見出しを圧縮
- 高さ430px以下の横画面はparallel headingを省略し、laneを2列維持
- `prefers-reduced-motion`ではparallel lane内animation／transitionを停止
- dialogにlabel、button type、cancel処理、busy stateを付与
- spectator commentは`aria-live="polite"`を維持し、同文DOM再挿入による読み上げ再発火も抑止

## 9. カード、得点、lifecycle監査

### カード

- pickはprovider handから同じcard objectをspliceしpickerへpush
- shootは同じbaba card IDを移動
- lane移動直後、pair cleanse後、group完了後に一意性監査
- stale candidate ID、既に移動済みcard ID、不正pick IDを拒否
- フルゲームとengine stressでduplicate／missingなし

### 得点

- v39のround snapshot冪等化を維持
- parallel group完了後だけround end判定
- shoot bank、Joker bank、completed round totalsの二重加算なし
- 最終`completedRoundTotalScore`と`final.total`一致をCPU4完走で確認

### lifecycle

- rematchでparallel group、shoot state、comment／animation event、timerを初期化
- room clearで全progress timerとresume identityを無効化
- CPU display identityは同じseat objectならrematch維持
- intentional leave後の旧token拒否
- temporary disconnectは同一player ID／seat／handへ復帰
- spectatorはcontinue、pick、play等のgameplay commandを拒否

## 10. v40専用テスト結果

`npm run test:v40`はPASS。

| suite | 主な確認 | 結果 |
|---|---|---|
| intentional leave | lobby/game player・spectator、host移譲、旧token拒否、一時切断復帰 | PASS |
| CPU identity/dialogue | CPU4自然名、emoji一致、重複なし、人格分離、同event DOM維持 | PASS |
| CPU-only round | spectator非block、2,600ms、人間45,000ms | PASS |
| parallel middle pick | 同時生成、別ID、独立待機、pair、stale、コメント1回、48 trick tempo | PASS |
| UI lifecycle | 指定14 viewport、leave modal、safe-area、44px、responsive、comment diff | PASS |

parallel pair cleanseテストは候補順shuffleを固定indexで仮定していた初版を監査中に検出し、card IDから実indexを求める決定論的テストへ修正した。その後25回連続PASSし、flaky testを残していない。

## 11. 指定command結果

| command | 結果 | 備考 |
|---|---|---|
| `npm test` | PASS | 全既存回帰＋v40、rule combinations 589,824、gameplay runs 1,536 |
| `npm run test:rules` | PASS | default、identity、baba、v39、shoot、rule matrix |
| `npm run test:ui` | PASS | mobile、layout、shoot、v40 UI |
| `npm run test:layout` | PASS | portrait／landscape／desktop／spectator |
| `npm run test:smoke` | PASS | 実WebSocket、92,854ms、全suit、human play/pick/pair |
| `npm run test:reconnect` | PASS | 同じplayer ID、13枚hand、復帰後play |
| `npm run test:resilience` | PASS | stale cleanup取消、切断auto play、同seat復帰 |
| `npm run test:fullgame` | PASS | 下記7シナリオを連続完走 |
| `npm run test:spectator` | PASS | viewer-specific privacy、spectator cleanup |
| `npm run test:v38` | PASS | baba rules、CPU4＋spectator完走 |
| `npm run test:v39` | PASS | rules、shoot UI、CPU席、CPU4、混成完走 |
| `npm run test:lobby-repeat` | PASS | add request反復、room clear再作成 |
| `npm run test:v40` | PASS | v40 5 suite |
| `node --check server.js` | PASS | 構文正常 |

## 12. 実ゲーム完走結果

`npm run test:fullgame`を更新後に一括実行し、すべてPASSした。

| 構成 | 結果 | 代表値 |
|---|---|---|
| 人間4・middle OFF | PASS | 51,286ms |
| 人間4・middle ON | PASS | 42,050ms |
| spectator host＋CPU4 | PASS | rematch role維持 |
| CPU4＋spectator | PASS | ババ移動state、最終得点 |
| CPU4・middle＋force Joker＋load/fire | PASS | 注目ルール3種ON |
| 人間3＋CPU1＋spectator host | PASS | player privacy／spectator全手札 |
| 人間1＋CPU3→人間離脱→CPU4 | PASS | CPU代打後107,907msで完走 |

加えて`test:smoke`で人間1＋CPU3相当のhuman操作、pick target、pair、全suit、最終得点を完走した。shootの乱数フルゲーム試行では発射が起きない回もあるため、発射／辞退／primary置換／secondary同時継続／1round 1回／得点冪等化は決定論的v39・v40専用テストで必ず通している。

## 13. viewport監査

次のviewportをレイアウト計算、DOM contract、tap target、safe-area、orientation media queryで監査しPASSした。

### iPhone縦

`320×568`、`375×667`、`390×844`、`393×852`、`430×932`

### 横

`568×320`、`667×375`、`844×390`、`932×430`

### PC／タブレット

`768×600`、`1024×768`、`1280×720`、`1440×900`、`1920×1080`

確認項目は2 laneの非重複、44px card/button、自分lane判別、他lane status、完了表示、spectator両lane、comment差分、hand dock、safe-area、reduced-motionである。

## 14. 実ブラウザ監査

**実ブラウザ視覚監査未実施。**

環境確認結果:

- `chromium`／`chromium-browser`／`google-chrome`: 無し
- Python Playwright: 無し
- Selenium: 無し

したがって、iPhone emulationの実スクリーンショットや実animation frameの目視確認は行っていない。代替として、HTML/CSS parser、JavaScript構文、viewport数値監査、DOM event ID非再生成テスト、WebSocket実通信テストを実施した。これは既知の検証制約であり、機能上の既知不具合ではない。

## 15. 最終全文検索

指定語を`server.js`、`public/index.html`、`tests`、`package.json`へ全文検索した。

- `nextSecondary`: 0件
- `CPU3`: 0件
- `CPU数字`表示生成: 0件
- `pendingPick`: middle OFF互換、公開互換、初期化、既存テストに限定して残存
- `pickStage primary/secondary`: role labelと共通lane処理に使用
- `postTrickFlow`: lane生成前の順位／役割確定とwinner保持に使用
- `setTimeout`: room scoped task以外はheartbeat、cleanup、single-pick互換、UI event lifecycleを確認
- `transientTimers`: group/pick scoped taskの一元管理を確認
- `reconnect`／`resume`／`leave`／`disconnect`: intentional flag、token無効化、temporary reconnectを別経路で確認
- `roundResult`／`continue`／`nextRound`: CPU-only分岐とhuman既存フローを確認
- `comment`／`dialogue`／`minimumVisibleUntil`: immutable event ID、priority、expiry、diff renderを確認

古い「primary完了後にsecondaryをproductionで開始」する経路はmiddle ONから除去した。個別lane共通ロジックを検証するために、テストが`beginPickStep(...secondary)`を単独で呼ぶ箇所はあるが、実ゲームの直列進行ではない。

## 16. 既知の制約

1. 実ブラウザ視覚監査は環境依存で未実施。上記のとおり明記済み。
2. CPUのカード選択と発射判断には意図的な乱数があるため、単一フルゲームで全重大eventが必ず発生するとは限らない。各分岐は決定論的回帰で補完した。
3. tempoのv39／v40比較値は同一production timingと48-trick event mixによるサーバー後処理モデルで、ネットワーク遅延や端末描画時間は含まない。

## 17. 完了判定

実ブラウザ視覚監査という環境制約を除き、指定された機能完了条件はすべてPASSした。

- 明示離脱、旧resume拒否、一時切断復帰: PASS
- ゲーム中CPU代打、host移譲、完走: PASS
- CPU4自然identity、人格分離、rematch維持: PASS
- spectator comment非再生成: PASS
- CPU-only 2.6秒自動進行: PASS
- middle OFF互換／ON真正並行: PASS
- 別pick ID、stale拒否、独立pair／fallback: PASS
- 2 lane終了後だけ次処理、コメント最大1回: PASS
- shoot／force Joker／privacy／reconnect整合: PASS
- duplicate card、score／timer二重処理なし: PASS
- 縦2段／横2列UI、44px、safe-area、reduced-motion: PASS
- 既存・v38・v39・v40・実WebSocket完走: PASS

