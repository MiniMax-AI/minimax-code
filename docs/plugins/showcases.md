# 插件详情 Showcase

每个插件可添加 `.minimax-plugin/showcases.json` 和 `showcase/` 原始媒体文件。
配置属于插件包版本；增加、修改、排序、清空、删除配置或更换素材都必须升级
`.minimax-plugin/plugin.json` 的 `version`。manifest schema v1 和 `exampleQueries` 保持原契约。
两区仓库分别维护当地语言文案，不增加语言字段，也不通过管理后台修改 Showcase。

```json
{
  "schemaVersion": 1,
  "items": [
    {"id": "copy", "text": "撰写产品介绍", "query": "请为这款产品撰写完整的介绍文案"},
    {"id": "image", "text": "生成宣传图", "query": "请生成一张产品宣传图",
     "media": {"type": "image", "path": "showcase/product.webp", "alt": "产品宣传图"}},
    {"id": "video", "text": "制作展示视频", "query": "请制作一段产品展示视频",
     "media": {"type": "video", "path": "showcase/product.mp4", "posterPath": "showcase/poster.webp"}}
  ]
}
```

`items` 顺序就是展示顺序。纯文字最多 3 项；有媒体时最多 10 项，可混入文字项。
每项一个 `id`、展示 `text`、完整 `query`，可选一份 `media`。点击案例使用详情所属插件和
完整提示词；媒体只用于展示，不作为输入附件。`id` 为插件内唯一、1–64 位 ASCII
字母、数字、`_`、`-`，修改文案时保留原 ID。`text`、`query` 必须非空，分别最多 4096
Unicode code points；可选 `alt` 最多 512 code points。短文案建议中文不超过 22 字、
英文不超过 12 词；经设计确认的专业术语案例可放宽到 28 字或 15 词。这些是编辑建议。

配置只接受以上字段，JSON 禁止重复键，`schemaVersion` 必须为整数 1。原始配置文件与
紧凑的发布 JSON 各自最多 256 KiB。`items: null` 非法；缺失文件与空数组有不同含义：

- 不放配置文件：详情继续使用旧 `exampleQueries`。
- `{"schemaVersion":1,"items":[]}`：新客户端隐藏 Showcase；若要旧客户端同时隐藏，
  还需将 manifest 的 `exampleQueries` 设为 `[]`。

媒体路径相对于插件根目录，必须是 `showcase/` 下非空普通文件，并遵守既有 portable path
规则；禁止 URL、绝对路径、`..`、符号链接和特殊文件。图片和视频封面仅支持 PNG、JPEG、
WebP，扩展名必须符合实际格式。视频仅支持 MP4/H.264，带音轨时须为 AAC，每条视频必须
配置 `posterPath`。校验使用固定版本 PyAV 从内存字节检查格式、编码和可解码帧，不转码，
不依赖系统安装的 `ffmpeg` 命令。全部文件继续遵守单文件 16 MiB、总文件大小 64 MiB、
最终 ZIP 64 MiB，以及既有文件数和路径限制。

## 打包与发布

配置和媒体以原始路径和字节进入 ZIP、`content_digest` 和 `archive_sha256`，没有忽略规则。
同版本内容变化由 Registry 的版本不可变约束拒绝，不能以改远端 URL 绕过升级。
Publisher 从打包使用的同一份 `package_entries` 准备媒体对象，复用 Logo 的 `icon_store`、
凭证、bucket 和前缀。它将同版本相同字节的媒体去重，使用下面的不可变对象 key：

```text
<object_prefix>/showcases/<plugin_name>/<plugin_version>/<sha256>.<ext>
```

`object_prefix` 默认 `plugin-marketplace/v1`，JPEG 扩展名统一 `.jpg`。OSS 实际 key 前仍叠加
当前部署的 `icon_object_prefix`；公开 URL 使用已有 `icon_base_url + object key`，不重复
叠加物理前缀。媒体 URL 必须使用 HTTPS，最多 2048 UTF-8 bytes。

所有区域请求先完成校验；每区的全部包、Logo 和 Showcase 上传成功后，才执行该区的一次
Catalog 发布。某区媒体上传失败时不会切换该区目录，其他区域仍可独立执行；不删除已上传
的不可变对象。`PublishPluginCatalogResp` 的 source_commit、plugin_count、unchanged 不变。

`--dry-run` 不上传：`catalog-request.json` 中新增 `showcase_config`，其中 media.type 为
IMAGE=1 / VIDEO=2，path/posterPath 转为正式 url/poster_url，移除 schemaVersion。
`objects.json` 同时输出媒体文件、内容类型、hash、物理 key 和各区公开 URL；`showcases/`
目录包含上传原始字节。没有配置的插件不新增该字段，旧发布请求保持兼容。

先合入 IDL MR !13497 并等待 rpc_gen，完成 server、biz 和 Relay 的字段传递及版本存储后，
再在测试环境发布带 Showcase 的新插件版本。上线仍按 README 的区域、测试/生产和审批
流程执行，不能只升级 Publisher 就假设消费链路已经可用。

## 校验

```bash
.venv/bin/python -m unittest tests.test_showcases tests.test_publisher -v
.venv/bin/python tools/validate_marketplace.py
.venv/bin/python tools/publish_marketplace.py --dry-run --source-commit <完整提交哈希> --output-dir dist/publisher-catalog
```

`tests/fixtures/showcase-media/` 是本地生成的 16×16 纯色合成素材，仅用于格式和编码测试。
`h264-aac.mp4` 是合法样例，`mpeg4.mp4` 和 `h264-mp3.mp4` 是拒绝样例；这些素材不进入
官方 catalog。格式校验不能代替正式素材的编辑检查、浏览器预览、CDN Range/CORS 和端到端验收。
