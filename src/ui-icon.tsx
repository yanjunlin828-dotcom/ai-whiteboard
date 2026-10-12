const paths = {
  board: 'M4 4h16v13H4z M8 21l4-4 4 4 M8 8h8 M8 12h5',
  plus: 'M12 5v14 M5 12h14',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  import: 'M12 3v12 M7 10l5 5 5-5 M4 15v5h16v-5',
  back: 'M14 5l-7 7 7 7',
  chevron: 'M6 9l6 6 6-6',
  formula: 'M18 4H6l7 8-7 8h12',
  rename: 'M15 4l5 5 M4 20l5-1L21 7l-5-5L4 14z',
  copy: 'M9 9h11v11H9z M15 5V2H2v13h3',
  archive: 'M3 4h18v4H3z M5 8v12h14V8 M10 12h4',
  restore: 'M4 9a8 8 0 1 1 0 7 M4 3v6h6',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
} as const;

export function UIIcon({name,className=''}:{name:keyof typeof paths;className?:string}){
  return <svg className={`ui-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
