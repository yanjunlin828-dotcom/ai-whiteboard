import {createHash} from 'node:crypto';
import {mathjax} from '../formula-runtime/node_modules/@mathjax/src/mjs/mathjax.js';
import {TeX} from '../formula-runtime/node_modules/@mathjax/src/mjs/input/tex.js';
import {SVG} from '../formula-runtime/node_modules/@mathjax/src/mjs/output/svg.js';
import {liteAdaptor} from '../formula-runtime/node_modules/@mathjax/src/mjs/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from '../formula-runtime/node_modules/@mathjax/src/mjs/handlers/html.js';
import {MathJaxFiraFont} from '../formula-runtime/node_modules/@mathjax/mathjax-fira-font/mjs/svg.js';
import '../formula-runtime/node_modules/@mathjax/src/mjs/util/asyncLoad/esm.js';
import '../formula-runtime/node_modules/@mathjax/src/mjs/input/tex/ams/AmsConfiguration.js';

const adaptor=liteAdaptor();RegisterHTMLHandler(adaptor);
const tex=new TeX({packages:['base','ams'],maxBuffer:4096,maxTemplateSubtitutions:1000,maxMacros:1000,
  formatError(_jax,error){throw new Error('公式语法有误：'+error.message);}});
const output=new SVG({fontData:MathJaxFiraFont,fontCache:'none'});
const document=mathjax.document('',{InputJax:tex,OutputJax:output});
let queue=Promise.resolve();
const cache=new Map();
export function renderFormula(input){
  const run=queue.then(()=>render(input));queue=run.catch(()=>{});return run;
}
async function render({latex,fontSize=30,color='#35639c'}){
  if(typeof latex!=='string'||!latex.trim()||latex.length>2000||!Number.isFinite(fontSize)||fontSize<16||fontSize>64||!/^#[\da-f]{6}$/i.test(color))throw new Error('公式内容、字号或颜色无效。');
  // No HTML, URLs, macro definitions, external packages or non-math text fallback.
  if(/\\(?:href|url|html\w*|class|cssId|style|includegraphics|require|newcommand|def|gdef|let)\b|[\u3400-\u9fff]/.test(latex))throw new Error('公式只接收数学 LaTeX；中文解释请放在相邻文本框。');
  const key=JSON.stringify([latex,fontSize,color]);if(cache.has(key))return cache.get(key);
  const node=await document.convertPromise(latex,{display:true,em:fontSize,ex:fontSize/2,containerWidth:1600});
  const svg=adaptor.firstChild(node);
  const box=adaptor.getAttribute(svg,'viewBox').split(/\s+/).map(Number);
  if(box.length!==4||box.some(n=>!Number.isFinite(n))||box[2]<=0||box[3]<=0)throw new Error('无法测量公式。');
  const pad=100,width=(box[2]+2*pad)*fontSize/1000,height=(box[3]+2*pad)*fontSize/1000;
  if(width>2000||height>1200)throw new Error('公式过长，请用 aligned 分行或拆成多条。');
  adaptor.setAttribute(svg,'viewBox',`${box[0]-pad} ${box[1]-pad} ${box[2]+2*pad} ${box[3]+2*pad}`);
  adaptor.setAttribute(svg,'width',String(width));adaptor.setAttribute(svg,'height',String(height));
  adaptor.setAttribute(svg,'xmlns','http://www.w3.org/2000/svg');
  let markup=adaptor.outerHTML(svg).replaceAll('currentColor',color);
  if(/<(?:script|foreignObject|image)\b|(?:href|src)=["'](?:https?:|data:|javascript:)/i.test(markup))throw new Error('公式输出包含不允许的外部内容。');
  const id=createHash('sha256').update(markup).digest('hex');
  const result={latex,fontSize,color,width,height,file:{id,mimeType:'image/svg+xml',dataURL:'data:image/svg+xml;base64,'+Buffer.from(markup).toString('base64'),created:0}};
  if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
