# ピピトリ v44 UI/UX改善・検証記録

## 結論と正本
v43「なかとーもどきCPU追加」版のソースを基準に、UIのみを改善しました。Render用サーバーの `server.js` はv43 ZIPとバイト単位で一致しています。サイトは同じフロントエンドを使い、既存のRender WebSocketへ接続します。RenderへのZIP反映は利用者が手動で行います。

ユーザーの行動：名前と参加方法を選び、部屋を作る／コードで参加し、友達・選択したCPUと3〜5人で対戦する。

## 監査と変更
|区分|発見した問題|実装した改善|
|---|---|---|
|情報設計・Navigation|作成後に設定が並び、参加後も作成UIが残る|作成前の折りたたみ設定、参加後は準備画面へ切替。CPU紹介も折りたたみ|
|Typography・視認性|補助文字9〜12px、主ボタンの白文字が淡い背景に埋もれる|入力・本文16px、説明13〜16px、操作14〜16px、見出し階層追加。主ボタンを濃い色へ|
|Layout・視線誘導|初期画面と開始操作が長い縦ページに埋もれる|ヘッダー・名前欄を圧縮。390pxの作成位置は約909px→666px。開始ボタンをコード共有直後に配置|
|Interaction|コード共有・エラー・CPU選択後の意味が弱い|コピー操作と結果通知、コード検証・Enter送信・参加中表示・再試行、CPU性格プレビューと操作できない理由|
|Mobile|小さいHUD・手札切替、固定結果操作が変形の影響で画面外へ出る|44px以上の主要操作、手札の説明領域確保、モバイルのボトムシート、結果アクションの固定・文字拡大時の再配置|
|アクセシビリティ|独自モーダルでフォーカスが背景に移る、札が絵文字中心の読み上げ|背景inert、Tab循環・Escape・フォーカス復帰、スート名と数字のaria名、focus可視化、reduced motion、rem文字と拡大時の縦配置|
|状態遷移|前の手番の一時通知が別フェーズに残る|手番外／対戦外で通知を消去。Waiting・Loading・Error・Disabledの説明を改善|

## 対象・非対象
変更対象：`public/index.html` の画面構成・CSS・クライアント表示と入力補助、検証記録、ブラウザー検証スクリプト。
変更しないもの：ゲームエンジン、得点・カード配布、ルールの既定値、CPU判断、通信メッセージ、再接続・観戦・離脱・部屋クリアのサーバー処理。標準のババ必須候補ON／追加ピックON／シュートOFF、3・4・5人、4種CPUの選択を維持。

## 実行した検証と結果
- Chromium + Playwright実画面：320 / 375 / 390 / 430 / 768 / 1024 / 1440px × ロビー・通常対戦・3枚パス・開始ペア・候補選択・ピック・ペア浄化・ラウンド結果・最終結果。63画面状態に加え文字200%とreduced motion、横overflowなし、JavaScript実行エラーなし。HUD・手札切替の実測は44px以上。
- 実通信の操作：5人部屋作成→なかとーもどき選択→CPU追加→満員→コードコピー→開始→手札の拡大表示。3人対戦でカードを選択・確定し手札17→16をサーバー状態で確認。
- 参加エラー、入力検証、ゲーム情報シート・ルールヘルプのTab/Escapeとフォーカス復帰。
- 文字200%：320pxロビーで横overflowなし。結果操作は通常表示でtop386 / bottom558（568px内）、200%でtop172.5 / bottom381.25。
- コントラスト計算：主CTA白文字6.49〜9.14:1、補助文字7.35:1、手札説明14.2:1。既存の結果コントラスト検査も通過。
- 通過：source_integrity / default_rules / player_count_3_5 / nakato_modoki_cpu / interaction_accessibility / final_result_scroll / final_result_contrast。
- 通過：test:reconnect、test:spectator、test:lobby-repeat、intentional_leave_v40、cpu_only_round_advance_v40、parallel_middle_pick_v40。
- test:uiのmobile_ui / layout_collision / v39_shoot_ui / v40_ui_lifecycleは通過。ただし従来の数式ベース検査は実画面検証とは分けて扱っています。

### 既存テストの未解消事項
- `v41_followup_regression.js` は旧4人専用文言を要求し、現在の3〜5人対応の文言で失敗します。
- `websocket_game_smoke.js` は旧シュートONのデフォルトを要求し、現在のOFFで失敗します。
- `cpu_identity_dialogue_v40_regression.js` は旧3種CPUの4人目の表示を要求し、現在の4種CPUで失敗します。
- これらは今回変更していない仕様のアサーションです。全npm testの完全通過は宣言しません。前版で見つかったルール行列の進行停止も、このUI変更では修正対象外です。

## 未確認・残課題
- 実機iPhone Safari、VoiceOverの実音声、実機ソフトウェアキーボード・ノッチの挙動は未確認。Safe Area指定・16px入力と仮想幅で確認した範囲です。
- 200%はroot font-sizeによる文字拡大の代替検証。OSのDynamic Typeや全ブラウザーの文字のみズームと同一ではありません。
- ゲーム卓の一部メタデータ・補助バッジは、カード卓の配置を保つため16px未満を維持。完全な16px統一や全要素のコントラスト監査ではありません。
- 公開後のRender本番を使った多端末の長時間フル対戦は未確認。今回の実通信検証はローカル同一サーバーに対して実施。
- 現在のRenderが旧バックエンドなら、3/5人・新CPUはZIPの手動反映後に有効になります。

## 証拠と再実行
`qa/v44/audit-v44.json`、`final-behavior-v44.json` を同梱しました。画面PNGは整理版ZIPから除外し、元のv44 ZIPに保持しています。
ブラウザー再実行はPlaywrightとブラウザーを別途用意し、`PORT=3034 npm start` の後、`node tests/browser_uiux_v44.cjs` と `node tests/browser_uiux_behavior_v44.cjs`。`UIUX_QA_URL` / `CHROMIUM_PATH`で確認先・ブラウザーを指定できます。実データ変更を避けるためローカル検証用サーバーを使ってください。

追加確認：人数別の早見表・ルールチップ・試合傾向を3人／4人／5人に合わせました。3人の実通信で追加ピックなしの説明を確認。
