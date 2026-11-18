---
title: Slack Moji
emoji: 😎
colorFrom: gray
colorTo: gray
sdk: static
app_build_command: npm run build
app_file: build/index.html
license: cc-by-nc-4.0
models:
  - thejagstudio/tessera-small
  - openai/clip-vit-base-patch32
thumbnail: https://huggingface.co/spaces/cfahlgren1/slack-moji/resolve/main/static/og.png
short_description: Describe an emoji. A tiny model paints it in your browser.
---

Describe an emoji and [Tessera-small](https://huggingface.co/thejagstudio/tessera-small) paints four 16×16 versions on your GPU with WebGPU. Nothing is sent to a server.

The denoiser and the CLIP ViT-B/32 text tower were exported to ONNX with fp16 weights (fp32 compute) and run with onnxruntime-web. The 16-step masked-diffusion sampler was ported to JavaScript from the Tessera code.

Tessera-small is by Jagrat Patel (TheJagStudio) and released under CC BY-NC 4.0, so this demo is non-commercial. The CLIP text encoder is OpenAI's (MIT).
