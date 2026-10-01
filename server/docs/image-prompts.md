# Image prompts

Live session WebSockets accept the existing Pi image content format:

```json
{"type":"prompt","text":"What is in this image?","images":[{"type":"image","mimeType":"image/png","data":"<base64>"}]}
```

Text may be empty or omitted when images are present. The raw RPC transport accepts the same images for `prompt`, `steer`, and `follow_up` commands (`message` instead of `text`).

Limits enforced before dispatch:

- 8 images per turn, 8 MiB decoded per image.
- 32 MiB total base64 characters and 64 KiB text characters.
- PNG, JPEG, GIF and WebP MIME types; base64 without a data URL prefix.
- An application-level 40 MiB inbound message limit before JSON parsing. The WebSocket transport's existing larger limit still applies while receiving the frame.

Clients should resize photos for their selected model's image limits; the gateway does not transcode images. Rejected semantic prompts produce `command_failed`; rejected RPC prompts produce an unsuccessful `rpc_result` with the original request ID and command. Validation failures do not close the session.

Durable `user_prompt` events contain only image descriptors (`images: [{mimeType, bytes}]`), not image pixels. Clients can retain local previews for their own sent turns and show attachment placeholders on replay or other devices. Other Pi transcript events keep their existing persistence behavior.

Queued REST prompts and scheduled jobs remain text-only.
