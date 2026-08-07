# ピピトリ v17 ブラウザ／ホーム画面アイコン設定記録

実施日：2026-07-20 JST

## 変更内容

- 豚の鼻と「ピピトリ」の文字を組み合わせた正方形アイコンを追加。
- PCブラウザタブ用のマルチサイズ `favicon.ico` を追加。
- PNG faviconとして16、32、48、64、192、512、1024pxを追加。
- iPhoneのホーム画面用に180pxの不透明な `apple-touch-icon.png` を追加。
- Web App Manifestを追加し、ホーム画面追加時の名称を「ピピトリ」、表示をstandaloneに設定。
- HTMLへfavicon、Apple Touch Icon、Manifest、theme-color、iOS用メタ情報を追加。
- `.webmanifest` を正しい `application/manifest+json` MIMEで配信。
- キャッシュ更新用にアイコン参照へ `?v=17` を付与。

## 検証

- PNGの署名と寸法を自動検査。
- ICOが複数サイズを持つことを自動検査。
- HTML内のfavicon／Apple Touch Icon／Manifest設定を自動検査。
- Manifestの名称、表示形式、theme color、192／512／maskableアイコンを自動検査。
- 既存のルール、通信、CPU、UI処理には変更なし。
