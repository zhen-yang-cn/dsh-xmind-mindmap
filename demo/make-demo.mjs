import { writeFile } from "node:fs/promises";
import { buildXmindBuffer } from "../lib/xmind.js";
import { writeZip } from "../lib/zip.js";
const tree = {
  title: "DSH 导图插件",
  notes: "用 XMind 的树形视图浏览 Markdown 与 .xmind",
  children: { attached: [
    { title: "view_xmind", notes: "直接读取 .xmind", children: { attached: [
      { title: "XMind 2020 content.json" },
      { title: "XMind 8 content.xml" },
    ] } },
    { title: "markdown_to_mindmap", href: "https://github.com/deepseek-ai/deepseek-harness", labels: ["转换"] },
    { title: "edit_mindmap_node", children: { attached: [
      { title: "update_title" }, { title: "add_child" }, { title: "delete_node" }, { title: "move_node" },
    ] } },
    { title: "xmind_to_markdown", labels: ["导出"] },
  ] },
};
await writeFile(new URL("./sample.xmind", import.meta.url), buildXmindBuffer(tree, { sheetTitle: "Plugin Overview" }));
const classic = `<xmap-content version="2.0"><sheet id="classic-sheet"><topic id="classic-root"><title>Classic XMind 8</title><children><topics type="attached"><topic id="c1"><title>Only content.xml</title></topic><topic id="c2"><title>Second branch</title><labels><label>legacy</label></labels></topic></topics></children></topic><title>Classic Sheet</title></sheet></xmap-content>`;
await writeFile(new URL("./classic.xmind", import.meta.url), writeZip([
  { name: "mimetype", data: Buffer.from("application/vnd.xmind.workbook"), store: true },
  { name: "content.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${classic}`, "utf8") },
]));
console.log("demo written");
