import { Box, Icon, Avatar } from '@mui/material';

const ICON_MAP = {
  arcade: 'arcade.png', mame: 'mame.png', 'final burn neo': 'mame.png',
  fc: 'fc.png', sfc: 'sfc.png', nes: 'fc.png', snes: 'sfc.png', n64: 'n64.png',
  gb: 'gb.png', gbc: 'gbc.png', gba: 'gba.png', nds: 'nds.png',
  psx: 'psx.png', ps1: 'psx.png', ps2: 'ps2.png', psp: 'psp.png',
  gen: 'genesis.png', genesis: 'genesis.png', megadrive: 'genesis.png',
  saturn: 'saturn.png', dc: 'dc.png', dreamcast: 'dc.png',
  gg: 'gg.png', gamegear: 'gg.png', sms: 'sms.png',
  ng: 'ng.png', neogeo: 'ng.png',
  tg16: 'tg16.png', pcengine: 'tg16.png',
  atari: 'atari.png', jaguar: 'jaguar.png', lynx: 'lynx.png',
  c64: 'c64.png', amiga: 'amiga.png', msx: 'msx.png',
  '32X': '32X.png', vb: 'vb.png', wonderswan: 'ws.png', wsc: 'wsc.png',
  ngp: 'ngp.png', ngpc: 'ngpc.png', sg1000: 'sg1000.png',
  coleco: 'coleco.png', vectrex: 'vectrex.png', intellivision: 'intellivision.png',
  '3do': '3do.png', cdi: 'cdi.png', fm7: 'fm7.png', pc88: 'pc88.png', pc98: 'pc98.png',
  x68000: 'x68000.png', zx: 'zx.png', zxspectrum: 'zx.png',
  pokemon: 'pokemon.png', sega: 'sega.png', sony: 'sony.png', nintendo: 'nintendo.png',
};

export default function IconDisplay({ name, fallback = 'folder', size = 24 }) {
  const icon = name || fallback;
  const filename = ICON_MAP[icon.toLowerCase()];
  if (filename) {
    return (
      <Box component="img" src={`/icons/${filename}`} alt=""
        sx={{ width: size, height: size, verticalAlign: 'middle', objectFit: 'contain' }}
      />
    );
  }
  const match = Object.entries(ICON_MAP).find(([key]) => icon.toLowerCase().includes(key));
  if (match) {
    return (
      <Box component="img" src={`/icons/${match[1]}`} alt=""
        sx={{ width: size, height: size, verticalAlign: 'middle', objectFit: 'contain' }}
      />
    );
  }
  const isIconName = /^[a-z][a-z0-9_]*$/i.test(icon);
  if (isIconName) {
    return <Icon sx={{ fontSize: size }}>{icon}</Icon>;
  }
  return <Avatar sx={{ width: size, height: size, fontSize: size * 0.5 }}>{icon[0]}</Avatar>;
}
