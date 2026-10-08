// The 16 league teams. Colors follow the provided palette (row 1 light, row 2 dark).
export const TEAM_DEFS = [
  { id: 'RR',  name: 'Rocky Rangers',       abbr: 'RRG', color: '#e6e6e6' },
  { id: 'NN',  name: 'Northern Nationals',  abbr: 'NOR', color: '#ffcfc9' },
  { id: 'SS',  name: 'Southern Saints',     abbr: 'SOU', color: '#ffc8aa' },
  { id: 'PP',  name: 'Pacific Pirates',     abbr: 'PAC', color: '#ffe5a0' },
  { id: 'EE',  name: 'Eastern Eagles',      abbr: 'EAS', color: '#d4edbc' },
  { id: 'GG',  name: 'Gulf Guardians',      abbr: 'GLF', color: '#bfe1f6' },
  { id: 'WW',  name: 'Western Warriors',    abbr: 'WES', color: '#c6dbe1' },
  { id: 'AA',  name: 'Atlantic Angels',     abbr: 'ATL', color: '#e6cff2' },
  { id: 'MM',  name: 'Midwest Mavericks',   abbr: 'MID', color: '#3d3d3d' },
  { id: 'CC',  name: 'Coastal Cardinals',   abbr: 'CST', color: '#b10202' },
  { id: 'SU',  name: 'Sierra Suns',         abbr: 'SIE', color: '#753800' },
  { id: 'DD',  name: 'Desert Diamondbacks', abbr: 'DES', color: '#473822' },
  { id: 'CE',  name: 'Central Celtics',     abbr: 'CEN', color: '#11734b' },
  { id: 'CY',  name: 'Canyon Cubs',         abbr: 'CAN', color: '#0a53a8' },
  { id: 'PR',  name: 'Prairie Panthers',    abbr: 'PRA', color: '#215a6c' },
  { id: 'VV',  name: 'Valley Vikings',      abbr: 'VAL', color: '#5a3286' },
];

export function isLight(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

/** Contrasting accent used for caps, numbers and text on the team color. */
export function accentFor(hex) { return isLight(hex) ? '#26323a' : '#f4f1ea'; }
