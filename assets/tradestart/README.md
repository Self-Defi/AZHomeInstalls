# AHI TradeStart — Share Image

This folder is reserved for the official TradeStart text-message and social preview image.

## Approved artwork
- Back-facing young Black field worker, plain dark shirt, tool bag and TV installation setting
- Image format: landscape 16:9 (1672 × 941 source PNG)
- Banner name when uploaded: `tradestart-share.png`
- Destination: `assets/tradestart/tradestart-share.png`

## Upload from mobile GitHub
1. In the AZHomeInstalls repository, navigate to `assets/tradestart/`.
2. Select **Add file → Upload files** (desktop browser view may be required on mobile).
3. Upload the approved image and rename it to `tradestart-share.png` before committing, if necessary.
4. Commit directly to `main`.

## Website hookup
Once the PNG exists, change the `og:image` and `twitter:image` on `tradestart/index.html` to `https://azhomeinstalls.com/assets/tradestart/tradestart-share.png` and set image dimensions and alt text. Never publish the image URL in metadata before its file exists. Text-message preview caches may need a new fetch to refresh.

The page remains: https://azhomeinstalls.com/tradestart/
