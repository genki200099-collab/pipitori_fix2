# ピピトリ v45 — iPhone操作改善

## 現在の結論
最新の `pipi_tori_online_v44_slim.zip`（取得時version 8）を正本として、iPhone向けの操作補助を実装しました。そのHTMLは本会話で取得したRender応答とバイト単位で一致しています。Sites版は接続設定などに差分があるため統合せず、Render用ZIPを更新しました。Renderへのアップロード・Sites公開は今回実施していません。

新しいDOM操作テスト・関連する既存テスト・ローカルの対戦通信検証は通過しました。描画するブラウザーを利用できず、最新画面のVisual確認は未完了です。『iPhone実機で確認済み』『全テストPASS』『公開済み』とは扱いません。

## 対象幅と判断
重点は320 / 375 / 390 / 430px。関連幅768 / 1024 / 1440pxもDOM操作ロジックを確認しました。844×390のタッチ端末相当／マウス端末相当を分け、横向きiPhoneでもシート操作を使えるようにしています。ここでの幅はDOMテストの仮想入力で、描画・overflow実測ではありません。

M規模・低リスクの範囲として、既存卓面・ルール・通信・カードの二段階確定・観戦を維持し、入力と補助画面を改善しました。

|検討項目|実装・判断|
|---|---|
|Navigation|既存のログ・ルール・観戦入口を維持。開閉状態、対象シート、ダイアログ種別をariaで通知。閉じると元の操作位置へフォーカス復帰。|
|Sheet / Drag / Swipe|ログ・ルールヘルプに44pxのハンドル。ハンドルのタップ・下スワイプ・キーボード操作で閉じる。短いドラッグやキャンセルでは閉じず、本文は通常スクロール。離脱・部屋クリアの確認にはスワイプ閉じを追加しない。|
|Bottom Bar / Safe Area|既存手札ドック・結果操作を維持。シートの上下左右Safe Areaと可視領域上限を補強。新しいナビゲーションバーは追加せず、卓面の領域を維持。|
|Touch Feedback|押下時の明度フィードバック、タッチ操作の指定。カードの変形を追加せず、既存の選択表示・演出を維持。|
|Long Press / カード操作|スワイプ・550ms以上の長押し・キャンセル・二本指操作では、札の選択／確定を送らない。通常のタップとキーボード・補助技術からのクリックは継続。部屋コードの長押しコピーは維持。|
|Keyboard|16px以上かつremに追従する入力。visualViewportと入力フォーカスからキーボード領域を扱い、隠れた入力を可視領域へスクロール。ピンチズーム中はシートの高さを再設定せず、入力位置への強制スクロールもしない。名前欄のEnterでキーボードを閉じる。|
|IME / コード入力|変換途中は入力を加工・送信しない。変換確定後に全角英数字を半角大文字へ補正。Enterの変換確定と参加送信を区別。|
|Scroll|情報シート表示中は背景のページ位置を固定。閉じると元の縦位置へ戻す。本文とログは単独でスクロールし、長い文字列は折り返す。|
|Animation|シートのドラッグ戻りは180ms。reduced motionでは遷移を無効化。ゲーム演出の既存設定は維持。|
|Typography / Accessibility|既存の見出しと本文を維持。シート見出しはrem・可変高さ、閉じる操作44px、focus可視化、aria名、expanded/controls/haspopupを追加。VoiceOverの実音声は未確認。|

## 主要変更ファイル
- `public/index.html`：補助ファイル読込、シートハンドル・背景ボタン、既存フォーカス管理への接続、IME対応、カード操作ガード。
- `public/iphone-ui.js`：スクロール固定・復帰、visualViewport、ジェスチャー判定、シートのドラッグ、aria開閉状態。
- `public/iphone-ui.css`：タッチフィードバック、Safe Area、可視領域上限、入力サイズ、スクロール、シートとreduced motion。
- `tests/native_iphone_v45_behavior.cjs`：DOM操作回帰。jsdomは検証環境に別途導入し、配布の依存関係には追加していません。
- `qa/v45/`：今回の結果と差分。`qa/v44/`は過去版の記録として保持し、今回の成功証拠にはしていません。

## 実行した検証
|方法|結果と限界|
|---|---|
|Diff Review|既存の機能ソースの変更はHTMLのみ。server.js・CPU処理・package/lock・既存テスト・画像等は元ZIPと一致。詳細は `diff-review.json` と `IPHONE_V45.diff`。|
|Static|ソース整合性、既存アクセシビリティ検査、モバイルUI・配置の数式／文字列検査、JavaScript構文、追加CSSの構文を確認。CSSのvar()を含む6宣言は値の意味検証対象外。|
|Automated / DOM Behavior|7幅と横向き2条件で、シート開閉・inert・フォーカス／スクロール復帰・IME・誤タップ抑止・通常の札選択／確定・送信1回を確認。可視領域と200%文字モードは模擬入力で確認。jsdomは描画もiOSエミュレーションもしません。結果 `native-dom-behavior.json`。|
|HTTP Behavior|ローカルの実サーバーからHTML・追加JS・追加CSSを取得し、200・MIME・内容一致を確認。結果 `http-assets.json`。|
|実通信回帰|再接続後の同じ席・13枚の手札復帰・カード送信受理、観戦と閲覧者別の手札公開、観戦者だけの部屋清掃、CPU追加とゲーム開始、部屋クリアと新部屋作成を確認。|
|Visual|今回の実画面・スクリーンショット検証は未実施。幅別の数式・DOM検証を画面確認とは呼びません。|

通過した既存検査：source_integrity、interaction_accessibility、mobile_ui、layout_collision、v39_shoot_ui、v40_ui_lifecycle、final_result_scroll、final_result_contrast、action_and_result_resilience、transient_visual_lifecycle、app_icon、default_rules、player_count_3_5、nakato_modoki_cpu。実通信はreconnect_recovery_smoke、websocket_spectator_v37、spectator_cleanup_v37、websocket_lobby_repeat_v34、websocket_room_clear_v36。

既存の `v41_followup_regression.js` は旧4人専用の文言 `1位↔4位と2位→3位を同時進行します` を要求して失敗。元v44 ZIPから抽出した変更前ソースでも同じ箇所の失敗を再現しました。`v41-existing-test.log` と `v41-baseline-test.log` に記録。今回、その文言やテストを変更していません。全npm testの成功は宣言しません。

## 未確認・残課題
- 最新の各画面（ロビー・3/4/5人卓・ピック・観戦・結果）を320 / 375 / 390 / 430 / 768 / 1024 / 1440pxで実際に描画した際のoverflow・重なり・縦横回転。
- 実機iPhone Safariのキーボード・ノッチ・シートドラッグ・背景固定の体感、VoiceOverの実音声。
- OS Dynamic Type、実描画での200%文字拡大、追加シートの見出し／閉じる操作の重なり、全要素のコントラスト実測。
- Renderへのv45反映と、その反映後の本番疎通・複数端末による対局終了までの回帰。
- 旧仕様前提の既存テスト整備は別課題。

## 次の作業
v45 ZIPをRenderへ反映し、重点幅と実機iPhoneで上記Visual／体感確認を行う。ゲームルール・CPU・サーバー仕様の変更は不要。

DOM検証を再実行するには、jsdomを別の検証用ディレクトリへ導入して `NODE_PATH=<そのnode_modules> node tests/native_iphone_v45_behavior.cjs`。本番用package/lockは変更しません。

画面検証の手順上の制約：使用した [sites-building SKILL.md](skill://sites@openai-curated-remote/root/.codex/plugins/cache/openai-curated-remote/sites/0.1.75/skills/sites-building/SKILL.md) の managed-linux preview 手順は、ブラウザー操作にcontrol-browserを指定し、未提供時に「If it is unavailable, do not improvise another browser-control path.」と指示しています。そのスキルが現在提供されていないため、今回のVisual確認を別の操作手段で代替していません。
