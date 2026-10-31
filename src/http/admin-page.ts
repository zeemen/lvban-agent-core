/**
 * 运营后台 · 知识管理的页面本体。
 *
 * 刻意是一张自包含的 HTML：没有构建步骤、没有新依赖、没有静态目录。
 * 这是内部工具，活在开发机上，值不上一套前端工程。
 */

export const ADMIN_KNOWLEDGE_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识库 · 采集与维护</title>
<style>
:root{--bg:#fbfaf7;--fg:#1c1a17;--dim:#6b655c;--line:#e2ddd3;--card:#fff;
      --bad:#a8321e;--warn:#8a6412;--ok:#2a6136;--accent:#1f4f7a}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#171614;--fg:#eceae6;--dim:#9a9389;--line:#302d28;--card:#1f1e1b;
  --bad:#e0896f;--warn:#d6ab52;--ok:#7fb98c;--accent:#79b2dd}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,
     "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:22px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);
  font:inherit;padding:8px 14px;cursor:pointer}
.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;white-space:nowrap}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;
     border:1px solid currentColor;margin:1px 3px 1px 0;white-space:nowrap}
.t-bad{color:var(--bad)} .t-warn{color:var(--warn)} .t-ok{color:var(--ok)} .t-dim{color:var(--dim)}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
input,textarea,select{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);
  border-radius:7px;background:var(--bg);color:var(--fg)}
textarea{min-height:76px;resize:vertical}
button.go{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:9px 18px;
  font:inherit;cursor:pointer;margin-top:14px}
button.go[disabled]{opacity:.5;cursor:default}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);
    border-radius:7px;padding:12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media(max-width:700px){.row{grid-template-columns:1fr}}
.hit{border-left:3px solid var(--ok);padding:6px 0 6px 10px;margin:8px 0}
.miss{border-left:3px solid var(--bad);padding:6px 0 6px 10px;margin:8px 0}
.ctx{color:var(--dim);font-size:12px}
.err{color:var(--bad)}
</style></head><body><div class="wrap">
<h1>知识库 · 采集与维护</h1>
<div class="sub">K3 长尾语料（规格 03 §5 证据链第三级）。仓库是源，WeKnora 是副本。</div>

<div class="tabs" role="tablist">
  <button id="t1" role="tab" aria-selected="true" onclick="show(1)">维护面板</button>
  <button id="t2" role="tab" aria-selected="false" onclick="show(2)">采集核验</button>
</div>

<section id="p1">
  <div class="card" id="summary">读取中…</div>
  <div class="card"><table id="tbl"><thead><tr>
    <th>文件</th><th>场景</th><th>来源</th><th>核对</th><th>问题</th><th>WeKnora</th>
  </tr></thead><tbody></tbody></table></div>
</section>

<section id="p2" hidden>
  <div class="card">
    <strong>先核对，再落笔。</strong>
    <div class="sub" style="margin:4px 0 0">
      凭域名猜会出错：kb-gongyuan 那次来源是对的，是人看走了眼。把要引用的话逐句贴进来，让它去原文里找。
    </div>
    <label>来源 URL</label>
    <input id="u" placeholder="https://…">
    <label>要核的句子（一行一句，照抄你打算写进摘要的说法）</label>
    <textarea id="c" placeholder="江南贡院始建于南宋乾道四年&#10;明远楼是江南贡院的重要组成部分"></textarea>
    <button class="go" id="vb" onclick="verify()">抓回原文核对</button>
    <div id="vr"></div>
  </div>
  <div class="card">
    <strong>生成房式草稿</strong>
    <div class="sub" style="margin:4px 0 0">字段顺序与现有 14 篇一致。复制后存到 content/knowledge/&lt;场景&gt;/&lt;知识ID&gt;.md。</div>
    <div class="row">
      <div><label>标题（用页面自己的题名，别把主办单位顶在前面）</label><input id="f_title"></div>
      <div><label>知识ID</label><input id="f_id" placeholder="kb-haoshe"></div>
      <div><label>场景</label><input id="f_scene" placeholder="fuzimiao"></div>
      <div><label>关联锚点</label><input id="f_anchors" placeholder="fzm_mingyuan_lou（没有就填 未记录）"></div>
      <div><label>关键词</label><input id="f_kw" placeholder="号舍、乡试、尺寸"></div>
      <div><label>原文定位</label><input id="f_loc" placeholder="文内号舍段"></div>
      <div><label>核对日期</label><input id="f_checked"></div>
      <div><label>资料发布日期</label><input id="f_pub" placeholder="未记录"></div>
    </div>
    <label>审核状态</label><input id="f_review" value="迁移待复核；不以平台解析成功代替内容审校。">
    <label>资料摘要与适用边界</label><textarea id="f_sum"></textarea>
    <button class="go" onclick="draft()">生成</button>
    <pre id="dr" hidden></pre>
  </div>
</section>
</div><script>
const GAP = {
  missing_source:['缺来源','t-bad'], missing_locator:['缺原文定位','t-warn'],
  unreviewed:['待复核','t-warn'], scene_mismatch:['场景词对不上锚点','t-bad'],
  stale_check:['核对日期过旧','t-dim'],
  anchor_placeholder:['关联锚点是占位编号','t-bad'], anchor_missing:['锚点还没建','t-warn'],
};
const esc = s => String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function show(n){for(const i of [1,2]){document.getElementById('p'+i).hidden=(i!==n);
  document.getElementById('t'+i).setAttribute('aria-selected',String(i===n));}}

(async function load(){
  try{
    const {docs} = await (await fetch('/v1/admin/kb/docs')).json();
    const n = docs.length, bad = docs.filter(d=>d.gaps.length).length;
    const by = {}; docs.forEach(d=>d.gaps.forEach(g=>by[g]=(by[g]||0)+1));
    document.getElementById('summary').innerHTML =
      '<strong>'+n+' 篇语料，'+bad+' 篇有待办。</strong> ' +
      Object.entries(by).map(([g,c])=>'<span class="tag '+GAP[g][1]+'">'+GAP[g][0]+' '+c+'</span>').join('');
    document.querySelector('#tbl tbody').innerHTML = docs.map(d=>'<tr>'+
      '<td><div>'+esc(d.file)+'</div><div class="ctx">'+esc(d.title)+'</div></td>'+
      '<td>'+esc(d.sceneId)+'</td>'+
      '<td>'+(d.sourceUrl?'<a href="'+esc(d.sourceUrl)+'" target="_blank" rel="noopener">打开</a>':'<span class="t-bad">—</span>')+
        '<div class="ctx">'+esc(d.locator)+'</div></td>'+
      '<td>'+esc(d.checkedAt||'—')+'</td>'+
      '<td>'+(d.gaps.length?d.gaps.map(g=>'<span class="tag '+GAP[g][1]+'">'+GAP[g][0]+'</span>').join(''):'<span class="tag t-ok">齐了</span>')+'</td>'+
      '<td>'+(d.weknora?'<span class="tag t-ok">'+esc(d.weknora.parseStatus)+'</span>':'<span class="tag t-dim">未入库</span>')+'</td>'+
      '</tr>').join('');
  }catch(e){ document.getElementById('summary').innerHTML='<span class="err">读不到语料：'+esc(e.message)+'</span>'; }
})();

async function verify(){
  const url=document.getElementById('u').value.trim();
  const claims=document.getElementById('c').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const out=document.getElementById('vr'), btn=document.getElementById('vb');
  if(!url||!claims.length){out.innerHTML='<p class="err">URL 和要核的句子都得填。</p>';return;}
  btn.disabled=true; out.innerHTML='<p class="ctx">抓取中…</p>';
  try{
    const r = await (await fetch('/v1/admin/kb/verify',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({url,claims})})).json();
    if(!r.ok){ out.innerHTML='<p class="err">这页没看成：'+esc(r.error)+'</p>'+
      '<p class="ctx">注意：这是「无法复核」，不是「资料里没有这句话」。别拿它当否定结论。</p>'; return; }
    out.innerHTML='<p class="ctx">页面标题：'+esc(r.title)+'（正文 '+r.textLength+' 字）</p>'+
      r.claims.map(c=>c.found
        ? '<div class="hit"><strong>原文里有</strong>：'+esc(c.claim)+'<div class="ctx">…'+esc(c.context)+'…</div></div>'
        : '<div class="miss"><strong>没找到</strong>：'+esc(c.claim)+'<div class="ctx">换个更短的说法再试——标点和断句不同会搜不到；仍找不到就别写进摘要。</div></div>'
      ).join('');
  }catch(e){ out.innerHTML='<p class="err">'+esc(e.message)+'</p>'; }
  finally{ btn.disabled=false; }
}

document.getElementById('f_checked').value = new Date().toISOString().slice(0,10);

async function draft(){
  const g=id=>document.getElementById(id).value;
  const r = await (await fetch('/v1/admin/kb/draft',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({
      title:g('f_title'),knowledgeId:g('f_id'),sceneId:g('f_scene'),anchors:g('f_anchors'),
      keywords:g('f_kw'),sourceUrl:document.getElementById('u').value.trim(),locator:g('f_loc'),
      checkedAt:g('f_checked'),publishedAt:g('f_pub'),reviewStatus:g('f_review'),summary:g('f_sum')})})).json();
  const pre=document.getElementById('dr'); pre.hidden=false; pre.textContent=r.markdown;
}
</script></body></html>
`
