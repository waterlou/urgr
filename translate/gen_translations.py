#!/usr/bin/env python3
"""Generate Chinese translations for MAME 0.288 games missing from mame_cn.lst"""

import sqlite3, re, os, sys
from collections import defaultdict

DB = '/Users/water/Documents/aicoding/gamemanager/data/roms.db'
OLD_TRANS = '/Users/water/Documents/aicoding/gamemanager/translate/mame_cn.lst'
MISSING_LIST = '/Users/water/Documents/aicoding/gamemanager/translate/missing_names.txt'
OUTPUT = '/Users/water/Documents/aicoding/gamemanager/translate/mame_cn_288.lst'

# Common English→Chinese translation mappings for game descriptions
TRANS_TERMS = {
    re.compile(r'\bWorld\b'): '世界版',
    re.compile(r'\bJapan\b'): '日版',
    re.compile(r'\bUSA\b'): '美版',
    re.compile(r'\bUS\b'): '美版',
    re.compile(r'\bEurope\b'): '欧版',
    re.compile(r'\bAsia\b'): '亚版',
    re.compile(r'\bKorea\b'): '韩版',
    re.compile(r'\bBrazil\b'): '巴西版',
    re.compile(r'\bAustralia\b'): '澳洲版',
    re.compile(r'\bChina\b'): '中国版',
    re.compile(r'\bTaiwan\b'): '台湾版',
    re.compile(r'\bHong Kong\b'): '香港版',
    re.compile(r'\bHispanic\b'): '西班牙版',
    re.compile(r'\bFrance\b'): '法版',
    re.compile(r'\bGermany\b'): '德版',
    re.compile(r'\bItaly\b'): '意版',
    re.compile(r'\bSpain\b'): '西版',
    re.compile(r'\bUK\b'): '英版',
    re.compile(r'\bbootleg\b', re.I): '盗版',
    re.compile(r'\bprototype\b', re.I): '原型',
    re.compile(r'\bhack\b', re.I): '改版',
    re.compile(r'\bencrypted\b', re.I): '加密',
    re.compile(r'\bdecrypted\b', re.I): '解密',
    re.compile(r'\bAlt(?:ernate)?\b'): '替代',
    re.compile(r'\bupright\b', re.I): '竖立机台',
    re.compile(r'\bcocktail\b', re.I): '台式',
    re.compile(r'\b(?:Revision|Rev)[. ]*(\w+)\b', re.I): lambda m: f'修正版 {m.group(1).upper()}',
    re.compile(r'\bversion[. ]*(\w+)\b', re.I): lambda m: f'第 {m.group(1).upper()} 版',
    re.compile(r'\bset[. ]*(\w+)\b', re.I): lambda m: f'第 {m.group(1).upper()} 套',
    re.compile(r'\b(?:earlier|earliest)\b', re.I): '早期',
    re.compile(r'\blater\b', re.I): '后期',
    re.compile(r'\bNew\b'): '新版',
    re.compile(r'\bOld\b'): '旧版',
    re.compile(r'\bNew\b'): '新版',
    re.compile(r'\bOld\b'): '旧版',
    re.compile(r'\b(?:unreleased|never released)\b', re.I): '未发布',
    re.compile(r'\bturbo\b', re.I): '极速版',
    re.compile(r'\bdeluxe\b', re.I): '豪华版',
    re.compile(r'\bspecial\b', re.I): '特别版',
    re.compile(r'\bpremium\b', re.I): '高级版',
    re.compile(r'\bstandard\b', re.I): '标准版',
    re.compile(r'\b(?:limited|limited edition)\b', re.I): '限量版',
    re.compile(r'\b(?:clone|clone of)\b', re.I): '克隆版',
    re.compile(r'\b(?:export)\b', re.I): '出口版',
    re.compile(r'\b(?:rental)\b', re.I): '租赁版',
    re.compile(r'\b(?:license|licensed)\b', re.I): '授权',
    re.compile(r'\b(?:bootleg|pirate)\b', re.I): '盗版',
    re.compile(r'\b(?:conversion|convert)\b', re.I): '转换',
    re.compile(r'\b(?:upgrade)\b', re.I): '升级',
    re.compile(r'\b(?:update)\b', re.I): '更新',
    re.compile(r'\bsystem\b', re.I): '系统',
    re.compile(r'\bbios\b', re.I): 'BIOS',
    re.compile(r'\b(?:firmware)\b', re.I): '固件',
    re.compile(r'\b(?:program|program rom)\b', re.I): '程序',
    re.compile(r'\b(?:sound|audio)\b', re.I): '音频',
    re.compile(r'\b(?:video|graphic|gfx)\b', re.I): '视频',
    re.compile(r'\b(?:i/o|iop?)\b', re.I): 'I/O',
    re.compile(r'\b(?:controller|ctrl)\b', re.I): '控制器',
    re.compile(r'\b(?:sub\b)?cpu\b', re.I): 'CPU',
    re.compile(r'\b(?:sub\b)?keyboard\b', re.I): '键盘',
    re.compile(r'\b(?:sub\b)?mouse\b', re.I): '鼠标',
    re.compile(r'\b(?:sub\b)?monitor\b', re.I): '监视器',
    re.compile(r'\b(?:sub\b)?key\b', re.I): '密钥',
    re.compile(r'\b(?:sub\b)?security\b', re.I): '安全',
    re.compile(r'\b(?:sub\b)?casino\b', re.I): '赌场',
    re.compile(r'\b(?:sub\b)?slot\b', re.I): '角子机',
    re.compile(r'\b(?:sub\b)?poker\b', re.I): '扑克',
    re.compile(r'\b(?:sub\b)?video\b', re.I): '视频',
    re.compile(r'\b(?:sub\b)?pinball\b', re.I): '弹珠台',
    re.compile(r'\b(?:sub\b)?table\b', re.I): '桌',
    re.compile(r'\b(?:sub\b)?game\b', re.I): '游戏',
    re.compile(r'\b(?:sub\b)?rom\b', re.I): 'ROM',
    re.compile(r'\b(?:sub\b)?cartridge\b', re.I): '卡带',
    re.compile(r'\b(?:sub\b)?disk\b', re.I): '磁盘',
    re.compile(r'\b(?:sub\b)?floppy\b', re.I): '软盘',
    re.compile(r'\b(?:sub\b)?hard\s?disk\b', re.I): '硬盘',
    re.compile(r'\b(?:sub\b)?cd-?rom\b', re.I): '光盘',
}

def translate_description(desc):
    """Translate an English game description to Chinese using pattern replacement"""
    if not desc:
        return ''
    
    result = desc
    
    # Apply translation patterns
    for pattern, replacement in TRANS_TERMS.items():
        if callable(replacement):
            result = pattern.sub(replacement, result)
        else:
            result = pattern.sub(replacement, result)
    
    # Clean up double spaces
    result = re.sub(r'\s+', ' ', result).strip()
    result = re.sub(r'\s*\(', ' (', result)
    result = re.sub(r'\)\s*', ') ', result).strip()
    result = re.sub(r'\s+', ' ', result)
    
    return result


def strip_variant(name):
    """Try to find a base game name by stripping common variant suffixes"""
    # Common variant suffixes in MAME naming
    # Try from longest to shortest
    suffixes = [
        'ar1', 'ar2', 'ar3',
        'jr1', 'jr2', 'jr3',
        'jo', 'ja', 'jb', 'jc', 'jd', 'je', 'jf', 'jg', 'jh', 'ji',
        'ua', 'ub', 'uc', 'ud', 'ue', 'uf', 'ug', 'uh', 'ui',
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
        '01', '02', '03', '04', '05',
        '10', '11', '12',
        'r1', 'r2', 'r3', 'r4', 'r5',
        'rev', 'prot',
    ]
    
    # Try removing suffix characters one at a time
    for i in range(len(name) - 1, 0, -1):
        base = name[:i]
        suffix = name[i:]
        if base.isalpha() or base.isalnum():
            return base
    return name


def main():
    print("Loading existing translations...")
    translations = {}
    with open(OLD_TRANS, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or '\t' not in line:
                continue
            parts = line.split('\t', 2)
            if len(parts) >= 2:
                translations[parts[0]] = line  # store full line
    
    print(f"  Loaded {len(translations)} translations")
    
    print("Loading missing names...")
    with open(MISSING_LIST, 'r') as f:
        missing_names = {line.strip() for line in f if line.strip()}
    print(f"  {len(missing_names)} missing names")
    
    print("Loading game data from database...")
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    
    # Load ALL games for version 2 into memory
    rows = conn.execute('''
        SELECT g.id, g.name, g.description, g.year, g.manufacturer,
               g.platform, g.isbios, g.isdevice, g.parent_game_id,
               g.runnable, g.driver_status
        FROM games g
        JOIN game_rom_sets grs ON grs.game_id = g.id
        WHERE grs.version_id = 2
    ''').fetchall()
    
    games_db = {}  # name -> row
    name_to_id = {}  # name -> id
    id_to_name = {}  # id -> name
    
    for row in rows:
        games_db[row['name']] = row
        name_to_id[row['name']] = row['id']
        id_to_name[row['id']] = row['name']
    
    print(f"  Loaded {len(games_db)} games")
    
    # Process missing names
    new_translations = []
    bios_count = 0
    device_count = 0
    parent_found = 0
    desc_translated = 0
    not_found = 0
    
    for idx, name in enumerate(sorted(missing_names)):
        if (idx + 1) % 1000 == 0:
            print(f"  Processing {idx+1}/{len(missing_names)}...")
        
        game = games_db.get(name)
        if not game:
            not_found += 1
            cn = name
            new_translations.append(f"{name}\t{cn}\t{cn}")
            continue
        
        cn_text = None
        desc = game['description'] or ''
        
        # Try parent_game_id first
        if game['parent_game_id']:
            parent_name = id_to_name.get(game['parent_game_id'])
            if parent_name and parent_name in translations:
                parent_line = translations[parent_name]
                parent_parts = parent_line.split('\t', 2)
                if len(parent_parts) >= 2:
                    parent_cn = parent_parts[1]
                    desc_tr = translate_description(desc)
                    if desc_tr and desc_tr != name:
                        cn_text = desc_tr
                    else:
                        cn_text = parent_cn
                    parent_found += 1
                    continue
        
        # Try stripping variant suffixes (longest first)
        if not cn_text:
            for i in range(len(name) - 1, 0, -1):
                base = name[:i]
                if base in translations:
                    parent_line = translations[base]
                    parent_parts = parent_line.split('\t', 2)
                    if len(parent_parts) >= 2:
                        parent_cn = parent_parts[1]
                        base_game = games_db.get(base)
                        base_desc = base_game['description'] if base_game else ''
                        suffix_desc = desc.replace(base_desc, '') if base_desc else ''
                        suffix_cn = translate_description(suffix_desc) if suffix_desc else ''
                        if suffix_cn:
                            cn_text = f"{parent_cn} ({suffix_cn})"
                        else:
                            cn_text = parent_cn
                        parent_found += 1
                        break
                    break
        
        # Use description translation
        if not cn_text:
            if game['isbios']:
                bios_count += 1
                cn_text = f"BIOS - {game['description'] or name}"
            elif game['isdevice']:
                device_count += 1
                cn_text = game['description'] or name
            else:
                desc_translated += 1
                desc = game['description'] or name
                cn_text = translate_description(desc)
        
        # Ensure we have something
        if not cn_text:
            cn_text = name
        
        # Clean up
        cn_text = re.sub(r'\s+', ' ', cn_text).strip()
        new_translations.append(f"{name}\t{cn_text}\t{cn_text}")
    
    conn.close()
    
    print(f"\nResults:")
    print(f"  BIOS entries: {bios_count}")
    print(f"  Device entries: {device_count}")
    print(f"  Parent-derived: {parent_found}")
    print(f"  Description-translated: {desc_translated}")
    print(f"  Not found in DB: {not_found}")
    print(f"  Total new: {len(new_translations)}")
    
    # Write output: old translations + new translations
    print(f"\nWriting {OUTPUT}...")
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        # Write old translations first
        for line in translations.values():
            f.write(line + '\n')
        # Write new translations
        for line in new_translations:
            f.write(line + '\n')
    
    print(f"Done! Total entries: {len(translations) + len(new_translations)}")

if __name__ == '__main__':
    main()
