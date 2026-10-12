# MCP 参数与工作流

以宿主实际工具定义为准。版本 0.3 提供 status、read、preview、patch、validate、render 六个工具。若新增工具或字段不可见，刷新 MCP 连接；项目 SDK 能验证协议，但不等于宿主已刷新。

## 身份、分页与事务

- status 返回 editors、readyReason；选择与用户目标匹配的 boardId。read 返回本次 editorSessionId 和 revision。
- read(summary=true) 返回 bounds 和 regions，不返回全部图元。regionId 按分区读取；offset/limit 分页须携带同一 revision，直到 nextOffset=null。truncated 表示还有下一页。
- preview/patch 必须传 boardId、editorSessionId、baseRevision、requestId，且 flow/items/edits 三选一。每批 items 或 edits 最多40；原生绑定文字也计入新增图元上限100。
- preview 返回 saved=false、PNG、validation、createdIds、affectedIds，不改变候选相关的磁盘版本或撤销历史。工具执行前仍会同步页面已有草稿。预览专用 regionId 在 patch 时去掉；内容和 requestId 相同。它不预留版本。
- validate/render 使用已保存的最新 revision。regionId 可包含该主区的子详解；render 的 elementIds 最多100并包含绑定文字。
- 已保存核心的 board_render 可按本次回读的核心成员 ID 传 elementIds，不为导航强行加容器。board_preview 不支持 elementIds，仅支持可选 regionId；候选核心先于外围详解绘制时检查其 PNG，后续候选按支持的区域检查，保存后再复看核心。regionId 包含外围子详解时可能使核心被缩得很小。核心超过100项时分视图核对，并在实际编辑页检查整体阅读，不把工具选择上限变成内容上限。
- 请求超时必须 status(boardId,requestId) 查询原板回执。transaction 存在时回读，禁止新 UUID 重复生成。候选预览没有保存回执。

## 分区与样式

需要分组的外框是没有 text 的 rectangle，声明 `region:{id,title,kind,order,lessonId,parentId?}`。id 是本课稳定短名；lessonId 区分不同课程。kind=main 为主要区域，detail 为相邻详解；parentId 表示语义归属，空间仍按 layout 保持邻近。成员使用 regionId，绑定文字自动随节点归属。外框标题用独立 text。region 是编辑和导航机制，不要求每个普通步骤都套外框；不分组的节点可直接绘制，聚焦使用 elementIds。真实容器包含内容时仍须声明 region，不以此绕过碰撞检查。

```json
{"id":"stage-box","type":"rectangle","x":100,"y":100,"width":900,"height":650,"region":{"id":"processing","title":"处理阶段","kind":"main","order":2,"lessonId":"diagram-demo"},"backgroundColor":"transparent","color":"#6b55a1","strokeWidth":1.5}
```

后续 items 可引用已保存的分区：

```json
{"id":"input-object","type":"rectangle","x":160,"y":220,"width":220,"height":110,"text":"输入对象","fontSize":32,"padding":12,"regionId":"processing","color":"#35639c","backgroundColor":"#edf3fb"}
```

上例仅展示参数关系，不是内容或尺寸模板；生成时使用资料中具体的职责与对象名称，不照抄“处理阶段”“输入对象”。

逻辑规划中的 ID、父级、角色、展示层级和引用关系不是新增工具字段。采用用户编号时为 MCP alias 保留合法、唯一的映射；跨批连接仍用实际回读 ID。编号不自动创建 region、绑定或箭头。内部 id/alias 保持稳定合法；可见 text 与 region.title 默认使用模块名称，不为隐藏编号改掉真实身份或破坏跨批引用。当前连接参数没有 text 字段，需要线旁短标签时用独立 text 对象放置并检查遮挡；不要给每条箭头自动追加标签，也不要杜撰布局伸展或原生表格参数。

文字支持 fontSize、maxWidth、color、regionId；节点另支持 padding、backgroundColor；线条支持 strokeWidth、strokeStyle、roughness。未知参数直接报错。maxWidth 按真实字体换行，过长不可分词仍可能溢出，检查后加宽或改短句。

同一 items 内用 alias 连接；跨批次用 edits.connect 的真实 ID。连接支持 fromPort/toPort（left/right/top/bottom）、route（默认 orthogonal）、via（绝对坐标折点）、endArrowhead（arrow/none）和样式。

```json
{"op":"connect","id":"callout-guide","from":"已读取的主节点ID","to":"已读取的相邻说明框ID","fromPort":"right","toPort":"left","route":"orthogonal","endArrowhead":"none","strokeStyle":"dashed","strokeWidth":1,"color":"#b2a3ce"}
```

上例可用于核心与独立附图之间的解释关联；短旁注与模块内已明确包含的说明可不连线。选择条件见 layout，不因工具支持连接就给每句话拉线。自动路由保留边中点、首末段方向并避开内容；复杂遮挡无可行路线会报 ROUTE_BLOCKED。via 必须形成直角且保持端口方向。不要用 straight 绕过应当修正的通道问题，也不靠长路线弥补解释放得太远。

## 已有内容的局部操作

| 操作 | 参数 | 用途 |
|---|---|---|
| set_text | target,text | 改独立文字或节点标签；长标签按真实字体测量 |
| move | target,dx,dy | 移动文字、节点、公式，重算相关声明式连接 |
| resize | target,width,height | 调整框体；公式必须保持比例；框体过小拒绝 |
| set_style | target,style | 字号、颜色、填充、线宽、线型；字号改变重新测量 |
| set_region | target,region 或 regionId | 将空矩形声明为分区，或给已有对象加入分区 |
| move_region | regionId,dx,dy | 移动主区及子详解、标签和公式，保留源码 |
| reroute | target,fromPort?,toPort?,route?,via?,endArrowhead? | 重算已有绑定箭头；不支持带文字或原生折肘箭头 |
| set_formula | target,latex,fontSize?,color? | 在本机重新渲染公式；公式渲染操作单独提交 |

target 默认真实 ID；$selection 必须附刚读取的 selectionIds。改字选一个逻辑目标。新批次不能重复执行同一目标的相同操作；预览应覆盖受影响邻居。

## 等待与修正

| 信号 | 下一步 |
|---|---|
| readyReason=input_active/unsaved/saving | 结束输入并等待保存；不要争抢编辑权 |
| stale_heartbeat/loading/offline | 回到用户目标编辑页；只按状态重查，不不停发送写入 |
| blocked/recovery | 先处理草稿；保留可下载的内容 |
| REVISION_CONFLICT/BOARD_MISMATCH | 重读身份、版本、目标及分区；重新预览 |
| CONTENT_COLLISION/REGION_MISSING | 明确分区归属或调整坐标；容器包含必须由 region 声明 |
| ROUTE_BLOCKED | 腾出走线通道或指定合法 via |
| TEXT_OVERFLOW/INVALID_LAYOUT | 检查字号、换行和真实宽高；不把文字缩小到难读 |
| LOCKED/UNSUPPORTED_TARGET | 报告具体目标，不能解锁或整板重建来补偿 |

validate 返回的问题包含 elementIds。SMALL_TEXT、LOW_DENSITY 是阅读提示，来源小字可有合理例外；CONTENT_OVERLAP、EDGE_CROSSING、TEXT_OVERFLOW、PORT_OFFSET 需要结合真实预览核对。它不验证公式数值、内容真实性、颜色对比或每种旋转图形的精确轮廓。

## 可编辑数学公式

本节只在资料确有需展示或修改的公式时使用，公式技术不限定任务领域。正文采用 Comic Shanns 轻手写，中文回退 Xiaolai，普通数学符号由 Noto 补齐；结构化公式使用 MathJax 4 与 Fira Math，保存 LaTeX 源码和内嵌 SVG 路径，在本机渲染。

以独立 items 文字项的 `text="$$LaTeX$$"` 创建带源码的 image；指定 regionId 可在已声明分区追加。修改用 set_formula(target,latex,fontSize,color)，或 set_text 的相同包裹格式。渲染公式的请求单独提交；move 和保持比例的 resize 可与普通布局操作同批。更新前读取源码，不凭图片猜公式。

可转换未锁定、无绑定的独立文字。节点标签、旋转、原生框架内对象和普通图片不支持转换；不能用纯文本覆盖已有公式元数据。手动通过顶部“公式”或双击已有公式编辑。

公式源不能含中文、外部链接、宏定义或动态包；中文说明另放。AI 每条源码最多500字符，手动2000；字号16–64。实际预览检查分母、上下标、负号、字母形状、颜色与间距，按渲染高度留空间，不压扁公式或缩小关键字来塞入原行高。

maxWidth 只用于普通文字换行，不限制公式 SVG 的宽高。公式的分式、求和与 argmin 下标可能明显增高；创建前按实际渲染尺寸安排所属框体和相邻说明，预览后核对边界。发现碰撞先确认是超出容器还是与正文重叠，再局部增加空间或调整位置，不能因已有 regionId 就认定任何尺寸都能容纳。

PNG 可对外展示，公式矢量路径不依赖外部字体；重新编辑使用本产品含源码的备份。旧“优化排版”模板不支持公式 image，须按 [legacy-laya.md](legacy-laya.md) 核对适用对象，不能称为通用公式重排能力。
