# Builds the probe fonts of the Blink shaper fixture
# (__test__/fixtures/text-fonts/blink-shaper.json) with fontTools:
#
#   uv run --with fonttools --with brotli python __test__/fonts/build-probe-fonts.py \
#     <NotoSansDevanagari-Regular source (.ttf/.woff2)> <Noto CJK subset-halt .otf>
#
# Sources:
# - Lato-Regular.ttf, Harmattan-Regular.ttf: in this folder.
# - Noto Sans Devanagari: @fontsource/noto-sans-devanagari 5.3.0,
#   files/noto-sans-devanagari-devanagari-400-normal.woff2 (OFL 1.1, no
#   Reserved Font Name).
# - NotoSansCJKjp-Regular-subset-halt.otf: WPT fonts/noto/cjk (OFL 1.1),
#   copied as is.
#
# Lato has the Reserved Font Name "Lato" and Harmattan "Fouta" (and the
# trademark "Harmattan"), so each modified copy gets a new family name.
import copy
import os
import shutil
import sys

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.otlLib.builder import buildStatTable
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import cmap_format_4
from fontTools.ttLib.tables._t_r_a_k import TrackData, TrackTableEntry

HERE = os.path.dirname(os.path.abspath(__file__))
LATO = os.path.join(HERE, 'Lato-Regular.ttf')
HARMATTAN = os.path.join(HERE, 'Harmattan-Regular.ttf')


def rename(font, family):
    # Keeps the copyright (0), license (13, 14) and trademark (7) notices.
    for rec in font['name'].names:
        if rec.nameID in (1, 4, 16, 18, 21):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = family.replace(' ', '')
        elif rec.nameID == 3:
            rec.string = family + ';probe'
        elif rec.nameID in (17, 22):
            rec.string = 'Regular'


def save(font, name):
    font.recalcTimestamp = False
    font.save(os.path.join(HERE, name))


def locl_probe():
    # locl maps 'a' to another glyph per OpenType language system, so the
    # width of "a" tells which language HarfBuzz used.
    f = TTFont(LATO)
    cmap = f.getBestCmap()
    g = {ch: cmap[ord(ch)] for ch in 'amwiMWxzk'}
    langs = [('ENG', 'm'), ('DEU', 'w'), ('FRA', 'i'), ('JAN', 'M'), ('ZHS', 'W'), ('NLD', 'x'), ('TRK', 'z'), ('ESP', 'k')]
    fea = ['languagesystem DFLT dflt;']
    fea += [f'languagesystem DFLT {t};' for t, _ in langs]
    fea += ['languagesystem latn dflt;']
    fea += [f'languagesystem latn {t};' for t, _ in langs]
    fea.append('feature locl {')
    for script in ('DFLT', 'latn'):
        fea.append(f'  script {script};')
        for t, ch in langs:
            fea.append(f'  language {t} exclude_dflt; sub {g["a"]} by {g[ch]};')
    fea.append('} locl;')
    del f['GSUB']
    addOpenTypeFeaturesFromString(f, '\n'.join(fea), tables=['GSUB'])
    rename(f, 'LoclProbe')
    save(f, 'LoclProbe.ttf')


def script_probe():
    # ccmp maps '1' to 'm' under DFLT and to 'w' under latn, so the width of
    # "1" tells whether HarfBuzz got script Latin or Common.
    f = TTFont(LATO)
    cmap = f.getBestCmap()
    g = lambda ch: cmap[ord(ch)]
    fea = f"""languagesystem DFLT dflt;
languagesystem latn dflt;
feature ccmp {{
  script DFLT; language dflt; sub {g('1')} by {g('m')};
  script latn; language dflt; sub {g('1')} by {g('w')};
}} ccmp;"""
    del f['GSUB']
    addOpenTypeFeaturesFromString(f, fea, tables=['GSUB'])
    rename(f, 'ScriptProbe')
    save(f, 'ScriptProbe.ttf')


def chws_probe(halt_src):
    # The Noto CJK halt subset plus a `chws` feature that reuses the `halt`
    # lookups, so chws on == halt everywhere.
    f = TTFont(halt_src)
    g = f['GPOS'].table
    old = list(g.FeatureList.FeatureRecord)
    new = list(old)
    added = {}
    for i, r in enumerate(old):
        if r.FeatureTag in ('halt', 'vhal'):
            c = copy.deepcopy(r)
            c.FeatureTag = 'chws' if r.FeatureTag == 'halt' else 'vchw'
            new.append(c)
            added[i] = c
    order = sorted(range(len(new)), key=lambda k: (new[k].FeatureTag, k))
    pos = {k: n for n, k in enumerate(order)}
    g.FeatureList.FeatureRecord = [new[k] for k in order]
    g.FeatureList.FeatureCount = len(new)
    idx_of = {id(new[k]): k for k in range(len(new))}
    for sr in g.ScriptList.ScriptRecord:
        for ls in [sr.Script.DefaultLangSys] + [l.LangSys for l in sr.Script.LangSysRecord]:
            if ls is None:
                continue
            fi = list(ls.FeatureIndex)
            extra = [idx_of[id(added[i])] for i in fi if i in added]
            ls.FeatureIndex = sorted(pos[i] for i in fi + extra)
            ls.FeatureCount = len(ls.FeatureIndex)
    rename(f, 'ChwsProbe')
    save(f, 'ChwsProbe.otf')


def arabic_split():
    # ArA: Harmattan without U+0644 in its cmap (GSUB/GPOS untouched).
    f = TTFont(HARMATTAN)
    for t in f['cmap'].tables:
        t.cmap.pop(0x644, None)
    rename(f, 'ArA')
    save(f, 'ArA.ttf')
    # ArB: Harmattan with upem 2048 -> 1536: everything 4/3 bigger.
    f = TTFont(HARMATTAN)
    f['head'].unitsPerEm = 1536
    rename(f, 'ArB')
    save(f, 'ArB.ttf')


def sym_cmap_probe():
    # Lato's U+0020..U+00FF glyphs behind a (3,0) symbol cmap at
    # U+F020..U+F0FF, and no other cmap subtable.
    f = TTFont(LATO)
    best = f.getBestCmap()
    sub = cmap_format_4(4)
    sub.platformID, sub.platEncID, sub.language = 3, 0, 0
    sub.cmap = {0xF000 + cp: best[cp] for cp in range(0x20, 0x100) if cp in best}
    f['cmap'].tables = [sub]
    os2 = f['OS/2']
    os2.ulCodePageRange1 = 1 << 31  # Symbol character set
    os2.ulCodePageRange2 = 0
    os2.usFirstCharIndex, os2.usLastCharIndex = 0xF020, 0xF0FF
    rename(f, 'SymCmapProbe')
    save(f, 'SymCmapProbe.ttf')


def trak_probe():
    # Lato with an AAT `trak` table (track 0: +200 units at 12 pt, 0 at 24 pt,
    # -100 at 40 pt) and a STAT table, which HarfBuzz needs to apply trak.
    f = TTFont(LATO)
    trak = newTable('trak')
    trak.version = 1.0
    trak.format = 0
    trak.horizData = TrackData({0.0: TrackTableEntry({12.0: 200, 24.0: 0, 40.0: -100}, nameIndex=256)})
    trak.vertData = TrackData()
    f['trak'] = trak
    f['name'].setName('Normal', 256, 3, 1, 0x409)
    rename(f, 'TrakProbe')
    buildStatTable(f, [], elidedFallbackName=2)
    save(f, 'TrakProbe.ttf')


def deva_subset(src):
    f = TTFont(src)
    f.flavor = None
    opts = Options()
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.notdef_outline = True
    opts.glyph_names = False
    s = Subsetter(opts)
    unicodes = [0x20, 0x200C, 0x200D, 0x25CC] + list(range(0x900, 0x980))
    s.populate(unicodes=unicodes)
    s.subset(f)
    save(f, 'NotoSansDevanagari-subset.ttf')


def main():
    deva_src, halt_src = sys.argv[1], sys.argv[2]
    locl_probe()
    script_probe()
    chws_probe(halt_src)
    arabic_split()
    sym_cmap_probe()
    trak_probe()
    deva_subset(deva_src)
    shutil.copyfile(halt_src, os.path.join(HERE, 'NotoSansCJKjp-Regular-subset-halt.otf'))


if __name__ == '__main__':
    main()
