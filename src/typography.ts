import {convertToExcalidrawElements,newElementWith} from '@excalidraw/excalidraw';
import type {ExcalidrawElement,ExcalidrawTextElement} from '@excalidraw/excalidraw/element/types';
import type {Scene} from './model';
import {loadBoardFonts} from 'virtual:whiteboard-fonts';
import {NOTE_HAND,NOTE_MATH,noteFont,noteTokens} from '../shared/typography.mjs';
import {applyEdits} from '../shared/edits.mjs';
import type {EditOperation,TextLayout} from '../shared/edits.mjs';

export const fontFamily=(text:string)=>noteFont(text) as ExcalidrawTextElement['fontFamily'];
export const fontStack=(family:number)=>({1:'Virgil',2:'Helvetica',3:'Cascadia',5:'Excalifont, Xiaolai',6:'Nunito',7:'"Lilita One"',8:'"Comic Shanns"',9:'"Liberation Sans"',10:'NoteHand, Xiaolai',11:'NoteMath, Xiaolai'}[family]??'sans-serif');
export async function prepareNoteFonts(text:string) {await loadBoardFonts(text);}

export function wrapNote(text:string,size:number,width:number,family=fontFamily(text)):string {
  const ctx=document.createElement('canvas').getContext('2d')!;
  ctx.font=`${size}px ${fontStack(family)}`;
  return text.split('\n').flatMap(line=>{
    const rows:string[]=[];let row='';
    for(const token of noteTokens(line)){
      if(row&&ctx.measureText(row+token).width>width){rows.push(row);row=token;}
      else row+=token;
    }
    rows.push(row);return rows;
  }).join('\n');
}

export function restyleNotes(elements:readonly ExcalidrawElement[],legacy=false) {
  let changed=false;
  const growth:EditOperation[]=[],layouts:Record<string,TextLayout>={};
  const next=elements.map(e=>{
    if(e.type!=='text'||e.isDeleted||e.locked||e.angle!==0||e.frameId)return e;
    const parent=elements.find(p=>p.id===e.containerId);
    if(parent?.locked||parent?.angle||parent?.type==='arrow')return e;
    const raw=e.originalText||e.text,family=fontFamily(raw);
    const upgrade=legacy&&(e.fontFamily===5||((e.fontFamily===NOTE_HAND||e.fontFamily===NOTE_MATH)&&e.customData?.noteTypography!==3));
    if(!upgrade&&!(e.fontFamily===NOTE_HAND&&family===NOTE_MATH))return e;
    const frame=!parent?elements.filter(p=>p.type==='rectangle'&&!p.isDeleted&&p.id.endsWith('-frame')&&
      p.x<=e.x&&p.y<=e.y&&p.x+p.width>=e.x+e.width-1&&p.y+p.height>=e.y+e.height-1)
      .sort((a,b)=>a.width*a.height-b.width*b.height)[0]:undefined;
    const dimension=(size:number)=>parent?.type==='ellipse'?Math.round(size/2*Math.sqrt(2))-10:parent?.type==='diamond'?Math.round(size/2)-10:size-10;
    const offset=(size:number)=>5+(parent?.type==='ellipse'?size/2*(1-Math.sqrt(2)/2):parent?.type==='diamond'?size/4:0);
    const width=parent?Math.max(30,dimension(parent.width)):frame?
      Math.max(40,frame.x+frame.width-e.x-Math.max(16,e.x-frame.x)):Math.max(e.width,40);
    const text=wrapNote(raw,e.fontSize,width,family);
    const measured=convertToExcalidrawElements([{type:'text',x:0,y:0,text,fontSize:e.fontSize,fontFamily:family,lineHeight:e.lineHeight}])[0];
    if(parent&&measured.height>dimension(parent.height)){
      growth.push({op:'set_text',target:e.id,text:raw});
      layouts[e.id]={text,width:measured.width,height:measured.height};
    }
    changed=true;
    return newElementWith(e,{fontFamily:family,text,width:measured.width,height:measured.height,
      ...(parent?{
        x:parent.x+offset(parent.width)+(e.textAlign==='left'?0:e.textAlign==='right'?dimension(parent.width)-measured.width:(dimension(parent.width)-measured.width)/2),
        y:parent.y+offset(parent.height)+(e.verticalAlign==='top'?0:e.verticalAlign==='bottom'?dimension(parent.height)-measured.height:(dimension(parent.height)-measured.height)/2),
      }:{x:e.x+(e.textAlign==='center'?(e.width-measured.width)/2:e.textAlign==='right'?e.width-measured.width:0)}),
      customData:{...e.customData,noteTypography:3}});
  });
  if(growth.length){
    const grown=applyEdits(next,{requestId:'font-layout',edits:growth},[],layouts);
    return grown.elements.map((e,i)=>JSON.stringify(e)===JSON.stringify(next[i])?next[i]:newElementWith(next[i],e));
  }
  return changed?next:null;
}

export async function prepareNoteScene(scene:Scene):Promise<Scene> {
  await prepareNoteFonts(scene.elements.filter(e=>e.type==='text'&&!e.isDeleted).map(e=>(e as ExcalidrawTextElement).text).join('\n'));
  return {...scene,elements:restyleNotes(scene.elements,true)??scene.elements,
    appState:{...scene.appState,currentItemFontFamily:(!scene.appState.currentItemFontFamily||scene.appState.currentItemFontFamily===5?NOTE_HAND:scene.appState.currentItemFontFamily) as ExcalidrawTextElement['fontFamily']}};
}
