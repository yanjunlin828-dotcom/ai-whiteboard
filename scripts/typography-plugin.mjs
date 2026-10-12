import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Version-checked in-memory adapter; installed dependency files stay intact.
export function typographyPlugin(root) {
  const base=resolve(root,'node_modules/@excalidraw/excalidraw');
  if(JSON.parse(readFileSync(resolve(base,'package.json'),'utf8')).version!=='0.18.1')
    throw new Error('Review the whiteboard font adapter before upgrading Excalidraw.');
  const chunk=resolve(base,'dist/dev/chunk-4FTI6OG3.js').replaceAll('\\','/');
  const font=resolve(root,'src/fonts/NotoSansMath-Regular.woff2').replaceAll('\\','/');
  const indices=resolve(root,'src/fonts/NotoSans-Indices.woff2').replaceAll('\\','/');
  return {name:'whiteboard-typography',enforce:'pre',
    generateBundle(){for(const name of ['NotoSansMath-LICENSE.txt','NotoSans-OFL.txt'])this.emitFile({type:'asset',fileName:'assets/'+name,source:readFileSync(resolve(root,'src/fonts',name),'utf8')});},
    resolveId(id) {
      if(id==='@excalidraw/excalidraw')return resolve(base,'dist/dev/index.js');
      if(id==='virtual:whiteboard-fonts')return '\0whiteboard-fonts';
    },
    load(id) {if(id==='\0whiteboard-fonts')return `import {Fonts} from ${JSON.stringify(chunk)};
      export const loadBoardFonts=(text)=>Fonts.loadElementsFonts([10,11].map(fontFamily=>({type:'text',fontFamily,text,originalText:text,isDeleted:false})));`;},
    transform(code,id) {
      const normalized=id.replaceAll('\\','/');
      if(normalized!==chunk&&normalized!==resolve(base,'dist/dev/index.js').replaceAll('\\','/'))return;
      const replace=(before,after)=>{
        if(code.split(before).length!==2)throw new Error('Excalidraw font adapter anchor changed: '+before);
        code=code.replace(before,after);
      };
      if(normalized!==chunk){
        replace('    value: FONT_FAMILY.Excalifont,','    value: FONT_FAMILY.NoteHand,');
        replace('text: fontFaces[0]?.fontFace?.family ?? "Unknown"',
          'text: familyId===10?"轻手写 · Comic Shanns":familyId===11?"圆润公式 · Comic Shanns":fontFaces[0]?.fontFace?.family ?? "Unknown"');
        return {code,map:null};
      }
      replace('  "Liberation Sans": 9','  "Liberation Sans": 9,\n  NoteHand: 10,\n  NoteMath: 11');
      replace('    case FONT_FAMILY.Excalifont:',
        '    case FONT_FAMILY.NoteHand:\n    case FONT_FAMILY.NoteMath:\n    case FONT_FAMILY.Excalifont:');
      replace('var DEFAULT_FONT_FAMILY = FONT_FAMILY.Excalifont;','var DEFAULT_FONT_FAMILY = FONT_FAMILY.NoteHand;');
      replace('const familyWithCJK = families.find(', 'const familyWithCJK = families.filter(');
      replace('if (familyWithCJK) {','if (familyWithCJK.length) {');
      replace('const characters = _Fonts.getCharacters(charsPerFamily, familyWithCJK);',
        'const characters = familyWithCJK.map(family=>_Fonts.getCharacters(charsPerFamily,family)).join("");');
      replace('    init("Cascadia", ...CascadiaFontFaces);',`    FONT_METADATA[10] = {...FONT_METADATA[8]};
    FONT_METADATA[11] = {...FONT_METADATA[8]};
    const mathSymbols = {uri:new URL(whiteboardMathUrl,window.location.href).href,
      descriptors:{unicodeRange:"U+370-3FF,U+2100-22FF,U+27C0-27EF,U+2980-2AFF,U+1D400-1D7FF"}};
    const mathIndices = {uri:new URL(whiteboardIndicesUrl,window.location.href).href,
      descriptors:{unicodeRange:"U+1D00-1D7F,U+2070-209F"}};
    init("NoteHand", mathSymbols, mathIndices, ...ComicShannsFontFaces);
    init("NoteMath", mathSymbols, mathIndices, ...ComicShannsFontFaces);
    init("Cascadia", ...CascadiaFontFaces);`);
      return {code:`import whiteboardMathUrl from ${JSON.stringify(font+'?url')};\nimport whiteboardIndicesUrl from ${JSON.stringify(indices+'?url')};\n`+code,map:null};
    }
  };
}
