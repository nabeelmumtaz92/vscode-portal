body=open('readme.html').read()
html=f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VSCode Portal - Visual Studio Marketplace</title><style>
*{{box-sizing:border-box}}body{{margin:0;font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif;color:#1e1e1e;background:#fff}}
.top{{background:#000;color:#fff;height:48px;display:flex;align-items:center;padding:0 24px;gap:14px;font-size:15px}}.top b{{font-weight:600}}.top .sep{{opacity:.5}}
.crumb{{padding:10px 24px;font-size:13px;color:#666;border-bottom:1px solid #eee}}.crumb a{{color:#0066b8;text-decoration:none}}
.banner{{background:#0e131b;color:#fff;padding:32px 24px}}.wrap{{max-width:1100px;margin:0 auto;display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}}
.banner img{{width:128px;height:128px;border-radius:12px}}.info h1{{margin:0 0 6px;font-size:30px;font-weight:600}}
.meta{{font-size:14px;color:#c8c8c8;display:flex;gap:14px;flex-wrap:wrap;align-items:center}}.meta a{{color:#4daafc;text-decoration:none}}
.stars{{color:#ffb900;letter-spacing:1px}}.desc{{margin:12px 0 16px;font-size:15px;color:#e8e8e8;max-width:640px}}
.btns{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}}.install{{background:#0e639c;color:#fff;border:0;padding:9px 22px;font-size:15px;border-radius:2px}}
.prem{{background:linear-gradient(90deg,#8b5cf6,#d946ef);color:#fff;border:0;padding:9px 18px;font-size:15px;border-radius:2px}}
.badge{{border:1px solid #6a6a6a;color:#ddd;font-size:12px;padding:3px 8px;border-radius:2px}}
.tabs{{max-width:1100px;margin:0 auto;display:flex;gap:26px;padding:0 24px;border-bottom:1px solid #ddd;font-size:15px}}.tabs div{{padding:12px 0}}.tabs .on{{border-bottom:2px solid #0066b8;font-weight:600}}
.main{{max-width:1100px;margin:0 auto;display:flex;gap:40px;padding:20px 24px;flex-wrap:wrap}}.readme{{flex:1;min-width:300px;font-size:15px;line-height:1.55}}
.readme img{{max-width:100%;border-radius:6px}}.readme pre{{background:#f3f3f3;padding:12px;overflow:auto;border-radius:4px}}.readme code{{font-family:Menlo,monospace;font-size:13px}}
.readme h2{{border-bottom:1px solid #eee;padding-bottom:6px}}.side{{width:260px;font-size:14px}}.side h3{{font-size:14px;margin:18px 0 8px}}
.chip{{display:inline-block;background:#f0f0f0;padding:3px 8px;margin:2px;border-radius:2px;font-size:12px}}
.plan{{border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:10px}}.plan.p{{border-color:#a855f7;background:#faf5ff}}.plan b{{font-size:15px}}.plan ul{{margin:6px 0 0;padding-left:18px}}
.mocknote{{background:#fff4ce;color:#5c4400;text-align:center;font-size:13px;padding:6px}}
</style></head><body>
<div class="mocknote">Mock-up preview, not live on the Marketplace</div>
<div class="top"><b>Visual Studio</b><span class="sep">|</span><span>Marketplace</span></div>
<div class="crumb"><a href="#">Visual Studio Code</a> › <a href="#">AI</a> › VSCode Portal</div>
<div class="banner"><div class="wrap"><img src="icon.png"><div class="info">
<h1>VSCode Portal</h1>
<div class="meta"><a href="#">Nabeel Mumtaz</a><span>|</span><span>⬇ 0 installs</span><span>|</span><span class="stars">☆☆☆☆☆</span><span>(0)</span><span>|</span><span class="badge">Free · Premium available</span></div>
<div class="desc">Code from your iPhone: run Claude Code, edit files live, review diffs, commit and push, all in the VS Code window on your Mac.</div>
<div class="btns"><button class="install">Install</button><button class="prem">✨ Get Premium</button><span style="font-size:13px;color:#aaa">Version 0.1.0</span></div>
</div></div></div>
<div class="tabs"><div class="on">Overview</div><div>Version History</div><div>Q &amp; A</div><div>Rating &amp; Review</div></div>
<div class="main"><div class="readme">{body}</div>
<div class="side"><h3>Plans (example)</h3>
<div class="plan"><b>Free</b><ul><li>Live editor</li><li>Changes: diffs, commit, push</li><li>One VS Code window</li></ul></div>
<div class="plan p"><b>Premium · $15 once</b><ul><li>Claude Code prompts</li><li>Terminal</li><li>Multiple windows</li><li>✨ Commit &amp; push</li></ul></div>
<h3>Categories</h3><span class="chip">AI</span><span class="chip">Other</span>
<h3>Tags</h3><span class="chip">phone</span><span class="chip">mobile</span><span class="chip">iphone</span><span class="chip">remote</span><span class="chip">claude code</span><span class="chip">git</span><span class="chip">tailscale</span>
<h3>Resources</h3><a href="#">Repository</a><br><a href="#">Issues</a><br><a href="#">License (MIT)</a>
<h3>More Info</h3><div>Version 0.1.0<br>Unique Identifier nabeelmumtaz92.vscode-portal</div>
</div></div></body></html>'''
open('index.html','w').write(html)
