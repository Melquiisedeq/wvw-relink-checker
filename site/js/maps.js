'use strict';
// ---------------------------------------------------------------------
// Tier maps
// Sector polygons, objective markers, tiers, claim emblems, tactics, pan
// and zoom. Ownership rides along with the match object the standings
// already fetch; positions come from the objective catalogue, once per
// session. The polygons share the objectives' coordinate space, so the
// markers land right by construction rather than by fitting. The terrain
// under them is a self-hosted wiki render - ArenaNet publishes no WvW
// tiles. See MAP_IMAGE below and the top of css/maps.css.
// ---------------------------------------------------------------------
// Tab order. Red last: it is the heaviest of the three, and sitting
// second it fought EBG for the eye.
const MAP_PANEL_ORDER = ['Center', 'BlueHome', 'GreenHome', 'RedHome'];
const MAP_PANEL_NAME = Object.freeze({
  Center: 'Eternal Battlegrounds',
  RedHome: 'Red Borderlands',
  BlueHome: 'Blue Borderlands',
  GreenHome: 'Green Borderlands',
});
const MAP_TAB_NAME = Object.freeze({
  Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL',
});
// Spawns never change hands, so they are only clutter on a map whose
// whole job is showing what changed.
const MAP_SKIP_TYPES = new Set(['Spawn']);
// Drawn biggest first: a camp painted over a keep would hide it, and the
// smaller thing is the one that has to stay on top.
const OBJ_DRAW_ORDER = ['Castle', 'Keep', 'Tower', 'Mercenary', 'Camp', 'Ruins'];
// Marker radius in map units. Markers scale by the inverse of the zoom,
// so this is also their size on screen at the default view. The closest
// two objectives on any map are 261 units apart, so 118 leaves every
// pair clear.
const OBJ_SIZE = Object.freeze({
  Castle: 118, Keep: 110, Tower: 100, Camp: 92, Mercenary: 92, Ruins: 80,
});
// How hard markers follow the zoom: 1 holds them fixed on screen, 0 pins
// them to the ground. 0.2 is near enough to pinned that every notch of
// the wheel visibly grows them - the earlier 0.45 came to 9% a notch and
// read as no change at all.
const MARKER_FOLLOW = 0.2;
// With markers that nearly follow the ground, the old 8.3x ceiling would
// have ended with a castle the size of a dinner plate. 4.5x is as far in
// as the terrain has detail to show anyway.
const MAX_ZOOM = 4.5;

// Where each picture sits in continent coordinates. Solved, not
// eyeballed: the renders carry the sector borders and the API publishes
// the same borders as polygons, so the transform is whatever makes the
// two coincide.
//
// `edge` is how wide our own border is drawn, in map units, and it has to
// cover the one already printed into the picture. All four renders carry
// the same 5-unit white line and 14 buries it. EBG printed a second one
// beside it, 23 units in the home team's colour, which 14 did not cover -
// that line was taken out of the image instead.
//
// `lite` is the same picture LITE_WIDTH pixels wide, a third to a half of
// the bytes. A map opens on it and takes `src` only once the zoom puts
// more pixels on screen than it holds - see upgradeTerrain.
const LITE_WIDTH = 1280;
const MAP_IMAGE = Object.freeze({
  38: { src: 'assets/map-ebg.webp', lite: 'assets/map-ebg-1280.webp', x: 8846.4, y: 12710.9, w: 3308.0, h: 3293.5, edge: 14 },
  1099: { src: 'assets/map-rbl.webp', lite: 'assets/map-rbl-1280.webp', x: 9133.8, y: 8866.1, w: 3228.6, h: 3245.6, edge: 14 },
  96: { src: 'assets/map-bbl.webp', lite: 'assets/map-bbl-1280.webp', x: 12718.3, y: 10865.3, w: 2660.6, h: 3623.1, edge: 14 },
  95: { src: 'assets/map-gbl.webp', lite: 'assets/map-gbl-1280.webp', x: 5534.1, y: 11493.7, w: 2693.0, h: 3638.3, edge: 14 },
});

// The three EBG mercenary camps are the only objectives the API publishes
// with an empty coord, and label_coord puts Molevekian Delve 139 units
// west of its own camp. So these were read off the map render at that
// image's own 1.1638 pixels per map unit - good to about 3 units against
// a marker radius of 92, which is all a marker has to manage.
const MERC_COORD = Object.freeze({
  '38-123': [9972.9, 14197.7],    // Molevekian Delve
  '38-125': [11284.6, 14096.6],   // Orgath Uplands
  '38-126': [10692.6, 15310.5],   // Darkrait Inlet
});

// The game's own icons off the wiki, in assets/icons. Only Keep and Tower
// are published in all four colours, so the rest were rebuilt: the
// coloured variants are the same image with only RGB changed, so
// grey -> team was learned from those two pairs and replays on them to
// within 0.2/255.
//
// Shipped at 96px rather than the published 32, enlarged with Lanczos and
// a light unsharp pass, so the browser is not left stretching 32px up to
// the 143px a marker reaches at full zoom. WebP: 115KB against 287 as
// PNG.
const MARKER_ICON = Object.freeze({
  Castle: 'Event_Castle', Keep: 'Event_Keep', Tower: 'Event_Tower',
  Camp: 'Event_Camp', Ruins: 'Event_Ruins',
  // The three EBG mercenary camps. The wiki has the crossed poleaxes the
  // game uses, but as a bare glyph - no disc, no team colour - so the
  // disc was rebuilt from the camp icon (radially averaged, its own glyph
  // skipped) and the axes knocked into it.
  Mercenary: 'Event_Mercenary',
});
let plotSerial = 0;
// How often open tier maps re-read their own match. The API serves match
// data with max-age=1, so the only lag is ours. One match is 82KB, and
// this runs only while the maps are open and the page is visible.
const MAP_REFRESH_MS = 30 * 1000;
// mapPollTimer, mapTickTimer and mapCatchUp are declared in popover.js.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mapCatchUp) mapCatchUp();
});
window.addEventListener('focus', () => { if (mapCatchUp) mapCatchUp(); });
// The last answer a poll got, paired with the standings match it was
// pulled against - one slot, because only one tier's maps are ever
// open. toggleTierMaps says what the pairing is for.
let freshRecall = null;

function markerIcon(type, owner) {
  const base = MARKER_ICON[type];
  if (!base) return null;
  const c = String(owner || '').toLowerCase();
  return `assets/icons/${base}${COLORS.includes(c) ? `_${c}` : ''}.webp`;
}

// Every upgrade a guild can install - ten tactics and eleven improvements
// - copied in as well. Serving every picture ourselves is what lets
// img-src stay 'self'. An id that is not here draws nothing rather than
// reaching for render.guildwars2.com, so a new upgrade degrades to its
// name alone.
const UPGRADE_ICONS = new Set([
  '1202661','1202662','1202663','1202664','1202665','1202666','1202667',
  '1202668','1202669','1202670','1202671','1202672','1202673','1202674',
  '1202675','1202676','1202677','1202678','1202679','1202680','1202681',
]);
const RENDER_FILE_RE = /^https:\/\/render\.guildwars2\.com\/file\/[0-9A-F]+\/(\d+)\.png$/;

function upgradeIcon(url) {
  const m = RENDER_FILE_RE.exec(String(url || ''));
  if (!m || !UPGRADE_ICONS.has(m[1])) return null;
  return `assets/icons/${m[1]}.webp`;
}

let objectiveCatalogue = null;
let upgradeCatalogue = null;
let tacticCatalogue = null;
const tacticAsked = new Set();
const sectorCache = new Map();

// The written-out copy, checked once. Missing or malformed it simply
// is not there, and everything below falls back to the API the way it
// always did.
function staticPack() {
  return (typeof WVW_STATIC === 'object' && WVW_STATIC) || null;
}

// Started once, in the background, with the map already drawn from the
// baked copy. Whatever comes back is what the NEXT opening uses - this
// never repaints under someone's cursor, and a map half from one
// catalogue and half from another is not a state worth having.
let catalogueRefreshed = false;

function refreshCatalogueSoon() {
  if (catalogueRefreshed) return;
  catalogueRefreshed = true;
  fetchJsonCached(`${API_BASE}/wvw/objectives?ids=all`).then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    const byId = new Map();
    for (const o of list) byId.set(o.id, o);
    objectiveCatalogue = byId;
  }).catch(() => { catalogueRefreshed = false; });
}

async function getObjectiveCatalogue() {
  if (objectiveCatalogue) return objectiveCatalogue;
  const pack = staticPack();
  if (pack && Array.isArray(pack.objectives) && pack.objectives.length) {
    const byId = new Map();
    for (const o of pack.objectives) byId.set(o.id, o);
    objectiveCatalogue = byId;
    refreshCatalogueSoon();
    return byId;
  }
  const list = await fetchJsonCached(`${API_BASE}/wvw/objectives?ids=all`);
  const byId = new Map();
  for (const o of Array.isArray(list) ? list : []) byId.set(o.id, o);
  objectiveCatalogue = byId;
  return byId;
}

// Asking for every upgrade line returns the same bytes as filtering to
// the ones in use - 48 lines, 137KB either way - so this no longer waits
// on the objective catalogue and runs alongside everything else.
async function getUpgradeCatalogue() {
  if (upgradeCatalogue) return upgradeCatalogue;
  const byId = new Map();
  try {
    const list = await fetchJsonCached(`${API_BASE}/wvw/upgrades?ids=all`);
    for (const u of Array.isArray(list) ? list : []) byId.set(u.id, u);
  } catch { /* upgrades are a nicety; the map works without them */ }
  upgradeCatalogue = byId;
  return byId;
}

// The guild tactics installed on an objective, which is a different
// thing from the upgrade tier: tiers are bought by yaks and arrive on
// their own, tactics are chosen by whoever claimed it. Fetched for the
// whole match in one request rather than per objective.
async function getTacticCatalogue(ids) {
  if (!tacticCatalogue) tacticCatalogue = new Map();
  // Asked, not just answered. An id the API declines to return would
  // otherwise be requested again on every repaint, for as long as the
  // popover stayed open.
  const want = [...new Set(ids)]
    .filter((id) => !tacticCatalogue.has(id) && !tacticAsked.has(id));
  if (!want.length) return tacticCatalogue;
  for (const id of want) tacticAsked.add(id);
  try {
    const list = await fetchJsonCached(`${API_BASE}/guild/upgrades?ids=${want.map(encodeURIComponent).join(',')}`);
    for (const u of Array.isArray(list) ? list : []) tacticCatalogue.set(u.id, u);
  } catch {
    // A dropped connection must not retire these ids for the session.
    for (const id of want) tacticAsked.delete(id);
  }
  return tacticCatalogue;
}

// A foreground id per guild, plus a catalogue of what each one draws, as
// layered PNGs. Only the first layer is used - the rest turn to mush at
// this size - painted white. One request per session.
let emblemPieces = null;
let emblemPiecesPromise = null;

// Both halves of the catalogue: the shapes a guild can pick for its
// backdrop and the ones it can pick for the device on top. Fetched
// together because an emblem needs both to be drawn at all.
function getEmblemPieces() {
  if (emblemPieces) return Promise.resolve(emblemPieces);
  if (!emblemPiecesPromise) {
    emblemPiecesPromise = Promise.all([
      fetchJsonCached(`${API_BASE}/emblem/backgrounds?ids=all`),
      fetchJsonCached(`${API_BASE}/emblem/foregrounds?ids=all`),
    ]).then(([bgs, fgs]) => {
      const pack = (list) => {
        const byId = new Map();
        for (const x of Array.isArray(list) ? list : []) byId.set(x.id, x);
        return byId;
      };
      emblemPieces = { bg: pack(bgs), fg: pack(fgs) };
      return emblemPieces;
    })
      // Dropped rather than remembered as an empty catalogue: kept, it
      // would blank every claim emblem until the page was reloaded,
      // because the answer is only ever fetched once. Clearing the
      // promise is what lets the next claimed objective ask again.
      .catch(() => { emblemPiecesPromise = null; return { bg: new Map(), fg: new Map() }; });
  }
  return emblemPiecesPromise;
}

// Dye colours for the guild emblems: id to hex, the cloth value of each,
// because a guild emblem is cloth. base_rgb is not the colour - it reads
// [128, 26, 26] for all 643 of them, being the reference each material
// transforms. /v2/colors publishes the colour after the shift, so there is
// nothing to reimplement. Baked in rather than fetched because ?ids=all
// measured 637KB and 1.6s against 7KB written out; an id that is not here
// falls back to the ink this used before.
const DYE_CLOTH =
  '1:7c6c53,2:252326,3:5f5c5c,4:484546,5:302e31,6:d3d0cf,7:003349,'
  + '8:016a87,9:004c6d,10:3682a0,11:001f34,12:48220f,13:41311d,14:58402a,'
  + '15:27251e,16:2a1607,17:472c17,18:361e03,19:353228,20:968469,21:301308,'
  + '22:564a38,23:7e6343,24:653b22,25:221b0b,26:5f4320,27:24417a,28:4a71bb,'
  + '29:04143e,30:122559,31:23578b,32:774b43,33:864135,34:5d2319,35:9f6a57,'
  + '36:965040,37:596680,38:2e4153,39:203a44,40:2f3148,41:314a48,42:485f5d,'
  + '43:28323f,44:2e525f,45:283a3d,46:3d5267,47:461041,48:5e1d64,49:793581,'
  + '50:9d5ca4,51:2d0923,52:666000,53:586e39,54:8a8127,55:1d653b,56:00260e,'
  + '57:0e2c0b,58:42865a,59:0a4f27,60:0f2f24,61:07351a,62:453b2e,63:3e4130,'
  + '64:714910,65:3f3921,66:5d2e0f,67:8a6732,68:3e4447,69:21292d,70:a7998e,'
  + '71:370400,72:464636,73:491a05,74:828a92,75:57534c,76:0e1c25,77:171b28,'
  + '78:241620,79:261702,80:0f1c14,81:201906,82:1e1725,83:250f0b,84:2b1618,'
  + '85:241209,86:0a1b1a,87:1a1829,88:161c0e,89:323c41,90:9a8372,91:7c6c53,'
  + '92:403d46,93:7c888a,94:9b8e79,96:4b3f39,97:373f38,98:746970,99:5f6460,'
  + '100:45463e,101:666455,102:ba6f57,103:615449,104:3c3900,105:455100,'
  + '106:5b6a00,107:272400,108:747f21,109:a04b17,110:3b0c00,111:ca6b39,'
  + '112:983f17,113:5f1700,114:452863,115:230f3d,116:5e468c,117:301a4d,'
  + '118:8160af,119:330002,120:a9484c,121:c2616a,122:470000,123:660006,'
  + '124:b65a80,125:751943,126:a9365e,127:4d0026,128:2f0019,129:405612,'
  + '130:192700,131:163900,132:235000,133:62893c,134:2d8c7f,135:00514c,'
  + '136:003831,137:006c6c,138:002323,139:353574,140:292159,141:6b6eb9,'
  + '142:4d5398,143:151340,144:7a4400,145:5e3100,146:895500,147:9b6c00,'
  + '148:ab8726,314:483f42,315:af9f7c,332:9c6a46,333:927743,334:827b3e,'
  + '335:86706b,336:998b70,337:765f54,338:562400,339:426d23,340:514500,'
  + '341:453000,342:2c1d00,343:b96b6b,344:bd8861,345:bb9755,346:959b5f,'
  + '347:7d9664,348:68947b,349:698f97,350:7579a1,351:8a6c99,352:945648,'
  + '353:736751,354:a37973,355:8f8f71,356:738083,357:8d7277,358:2b322e,'
  + '359:6d7a4a,360:5e785b,361:50706a,362:506773,363:5b5e78,364:715063,'
  + '365:814646,366:765632,367:4b4422,368:57291b,369:5a3808,370:273300,'
  + '371:4a3751,372:302a41,373:7f7363,374:c55d4b,375:9d3e2d,376:85241a,'
  + '377:580800,378:470000,379:b4752a,380:98560b,381:864000,382:7b3000,'
  + '383:624225,384:4b382e,385:5b5f63,434:6f4326,435:5a4620,436:4d2121,'
  + '437:552f16,438:383c16,439:514a64,440:36273f,441:482a3d,442:8e8a78,'
  + '443:bdbab9,444:857a60,445:8e9881,446:7f7272,447:a0826c,448:7d8674,'
  + '449:777987,450:4b3a2d,451:2c3439,452:6b5b3c,453:392920,454:473f33,'
  + '455:2f281c,456:21130e,457:4d3e26,458:292c36,459:4f3929,460:807383,'
  + '461:74867d,462:9e8b66,463:4a2a2a,464:342d38,465:393522,466:6c3e2d,'
  + '467:695637,468:88533f,469:483b1b,470:2b230c,471:3d2b31,472:4a361a,'
  + '473:1a181b,474:524f4f,475:6b6969,476:3b393c,477:9d9a9a,478:624c3f,'
  + '479:81654d,480:9c7e51,481:a16d55,482:000000,483:000008,484:323b2d,'
  + '485:343223,582:752200,583:21356a,584:9d8e6c,585:c7a23d,586:330000,'
  + '587:a0a8b9,588:284e82,589:523776,590:6687c6,591:e09e5c,592:770000,'
  + '593:6b1400,594:e38350,595:ee9566,596:d8aa86,597:414f53,598:b2a740,'
  + '599:1a4400,600:a97815,601:371700,602:322f00,603:595fa9,604:411e00,'
  + '605:382800,606:00453e,607:103300,608:500c00,609:3a0f32,610:7d7a7a,'
  + '611:8e8a88,612:687600,613:7cb286,614:7895cd,615:662d6c,616:893203,'
  + '617:1c5a2d,618:4d2a00,619:b34d74,620:a366aa,621:d8b080,622:ac6620,'
  + '623:cc8a48,624:b7678b,625:005f7c,626:42447f,627:47514b,628:ccb471,'
  + '629:5a0000,630:63a46f,631:9cc4a0,632:2a5c05,633:b14d3b,634:22788f,'
  + '635:75974a,636:86a956,637:a9c188,638:499864,639:43978c,640:6369b5,'
  + '641:8e2652,642:d4b254,643:888266,644:382f67,645:6b654c,646:b5bc72,'
  + '647:b95629,648:97322c,649:8fa7d3,650:e7a876,651:e0ae73,652:dabc6b,'
  + '653:8ac094,654:9ebc75,655:b3bc5e,656:efab8b,657:f7aa9d,658:a895c3,'
  + '659:cb8ca9,660:83bbac,661:c1b759,662:9398d6,663:b88dbc,664:85b3c1,'
  + '665:d9ab95,666:a94165,667:884a8e,668:d8aca4,669:e18076,670:541c54,'
  + '671:9b83bc,672:b1a4c3,673:87000a,674:00405b,675:3c2456,676:386299,'
  + '677:6e3b00,678:bd7294,679:c99eb2,680:610a35,681:6bac9e,682:55ad9a,'
  + '683:96bab1,684:787dc0,685:8f77b0,686:642700,687:736d00,688:5b4e00,'
  + '689:297549,690:97a53b,691:488f9f,692:496100,693:c5bd70,694:4b772a,'
  + '695:7b7600,696:01776e,697:9d922a,698:a0252f,699:f39a91,700:3d70a2,'
  + '701:765c9d,702:f79b7e,703:a99c81,704:005d5d,705:431a00,706:6b5490,'
  + '707:868bc9,708:9da0c4,709:064224,710:ac7db1,711:bc9dbf,712:6fa2b1,'
  + '713:5699ae,714:96b1ba,715:89932a,1053:e17967,1054:3e4100,1149:791a09,'
  + '1150:440000,1151:601300,1152:2d0000,1153:550000,1154:a1660c,'
  + '1155:c58d36,1156:455139,1157:3e574f,1158:42485a,1159:47435a,'
  + '1160:573e4f,1161:574747,1231:3c6a65,1232:3d5e6f,1233:597d8f,'
  + '1234:578984,1235:2f4d4a,1236:304550,1237:cb8c16,1238:dab44d,'
  + '1239:9c5915,1240:8b2e12,1241:423a31,1242:8e8b73,1243:354100,'
  + '1244:6e7a36,1245:5b6100,1246:466300,1247:212400,1248:4c7200,'
  + '1249:443582,1250:664785,1251:7f8f05,1252:005562,1253:290935,'
  + '1254:3d125d,1265:9e5353,1266:928032,1267:9c6c3d,1268:597c35,'
  + '1269:376f8d,1270:6f378d,1271:604600,1272:31581d,1273:064857,'
  + '1274:4c0e4c,1275:5a2200,1276:4e0000,1277:003127,1278:002911,'
  + '1279:1c1c43,1280:411313,1281:3a2e03,1282:4f0821,1301:8fffa2,'
  + '1302:ffb088,1303:fffc5e,1304:ff8cac,1305:82c8ff,1306:b390ff,'
  + '1307:aeb6d7,1308:a9bdd4,1309:a5cdc9,1310:c0a8d3,1311:afd7b5,'
  + '1312:d1c3a7,1333:edb227,1334:810000,1335:580000,1336:990000,'
  + '1337:d89d00,1338:c37600,1348:080900,1349:110000,1350:0f0000,'
  + '1351:04000c,1352:080009,1353:0b0005,1354:000000,1355:001000,'
  + '1356:000908,1357:00030c,1358:3b7d8c,1359:814381,1360:537a3e,'
  + '1361:a28800,1362:8a5200,1363:9b0f29,1364:37342c,1365:7e6121,'
  + '1366:48443c,1367:5d5951,1368:4f3f12,1369:7a5f2d,1370:745a00,'
  + '1371:3e0100,1372:3d212f,1373:8a4800,1374:cfcfb1,1375:730e00,'
  + '1376:001f4c,1377:3b5475,1378:27528b,1379:001c67,1380:6091d3,'
  + '1381:0c203d,1382:8795a8,1383:495566,1384:7793b9,1453:630007,'
  + '1454:00001a,1455:0a000a,1456:310000,1457:3d003d,1458:2c004c,'
  + '1477:b74725,1478:210000,1481:f6f0b3,1485:898989,1486:185240,'
  + '1489:1e1c1f,1490:ab0078,1493:172585,1495:7a9600,1497:bd000b,'
  + '1498:2d2c3f,1499:b08f80,1537:f05000,1538:ff9303,1539:ffec4c,'
  + '1540:c40000,1541:ee2500,1542:070000,1549:e8e2e1,1550:52abec,'
  + '1551:e8ffff,1552:fafffa,1553:ffffff,1554:77ba83,1573:714737,'
  + '1574:4d5420,1575:fbc940,1576:2d231f,1577:28aeae,1578:2c2400,'
  + '1579:c8aa82,1580:000000,1581:738983,1582:262626,1583:543831,'
  + '1584:b2a99d,1585:343434,1592:326b35,1593:303d62,1594:330202,'
  + '1595:1a8ac5,1596:d4f058,1597:b06200,1598:a1947e,1599:060a13,'
  + '1600:8f7224,1601:3d3900,1602:a97451,1617:001e00,1618:917707,'
  + '1619:913600,1620:603a00,1621:3e9500,1622:000000,1623:230050,'
  + '1624:b9b9f4,1625:ab00ab,1627:5e005e,1628:00002f,1629:5b00d4,'
  + '1633:000f45,1634:ca9800,1635:a47b0e,1636:77d5ff,1637:003e9a,'
  + '1638:ffd96b,1639:ff4900,1640:717171,1641:474747,1642:8a0c0c,'
  + '1643:653b3b,1644:a94900,1645:04042e,1646:725439,1647:a4a5a6,'
  + '1648:5b522d,1649:3b4753,1650:144382,1651:001f6e,1652:1e364f,'
  + '1653:2323cb,1654:125ba3,1655:298829,1656:009400,1657:13d413,'
  + '1658:004a00,1659:d40303,1660:882929,1661:6e1a1a,1662:933f3f,'
  + '1663:6d643f,1664:b58b00,1665:715e0a,1666:7e6500,1667:004991,'
  + '1668:ffff8c,1669:99a5b1,1670:078585,1671:fcf2d5,1672:d9b0ff,'
  + '1673:9eefff,1674:ffff99,1675:ff69b7,1676:ffe09f,1677:ffbebe,'
  + '1678:7eff7e,1679:004432,1680:78aa00,1681:0d7953,1682:000000,'
  + '1683:000000,1684:000000,1685:000000,1686:000000,1687:00a14f,'
  + '1688:000000,1689:085c08,1690:026140,1691:000078,1692:7f0036,'
  + '1693:12002a,1694:096868,1696:292988,1698:693f69,1699:680968,'
  + '1700:36007f,1701:802d2d,1702:9d0024,1703:00004a,1704:230050,'
  + '1706:6d5c12,1707:585858,1708:f4d4fb,1709:063667,1710:4f1e36,'
  + '1711:4d774d';

let dyeRgb = null;

// Parsed on first sight, not at load: a tier with nothing claimed never
// pays for it.
function dyeHex(id) {
  if (!dyeRgb) {
    dyeRgb = new Map();
    for (const pair of DYE_CLOTH.split(',')) {
      const cut = pair.indexOf(':');
      if (cut > 0) dyeRgb.set(Number(pair.slice(0, cut)), pair.slice(cut + 1));
    }
  }
  return dyeRgb.get(Number(id)) || null;
}

// The dye, untouched. With the emblem's own backdrop drawn underneath
// there is nothing to correct for, and correcting anyway would be
// repainting a design its guild chose. The fallback covers a dye added to
// the game after the table was written.
function emblemInk(hex) {
  const n = hex ? parseInt(hex, 16) : NaN;
  if (!Number.isFinite(n)) return [0.09, 0.07, 0.04];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// The emblem as a stack of tinted layers, bottom first.
//
// The one thing here that is written down nowhere: the foreground's FIRST
// layer is not drawn. It is the whole device in the game's base red, and
// the layers after it are the masks for the coloured regions, one per
// entry in colors. Checked against a working renderer pixel by pixel -
// leaving layer 0 out scored 0.33 average error per channel, and every
// version that drew it scored between 5 and 9. The background has one
// layer and no such spare.
function emblemLayers(info, pieces) {
  const em = info && info.emblem;
  if (!em || !pieces) return [];
  const out = [];
  const flags = new Set(em.flags || []);

  const bgEntry = pieces.bg.get(em.background && em.background.id);
  const bgColors = (em.background && em.background.colors) || [];
  for (const [i, src] of ((bgEntry && bgEntry.layers) || []).entries()) {
    out.push({
      src,
      hex: dyeHex(bgColors[i]),
      flipH: flags.has('FlipBackgroundHorizontal'),
      flipV: flags.has('FlipBackgroundVertical'),
    });
  }

  const fgEntry = pieces.fg.get(em.foreground && em.foreground.id);
  const fgColors = (em.foreground && em.foreground.colors) || [];
  const fgLayers = ((fgEntry && fgEntry.layers) || []).slice(1);
  for (const [i, src] of fgLayers.entries()) {
    out.push({
      src,
      hex: dyeHex(fgColors[i]),
      flipH: flags.has('FlipForegroundHorizontal'),
      flipV: flags.has('FlipForegroundVertical'),
    });
  }
  return out;
}

// One filter per colour, built on first use and parked in the defs it
// is given. Shared by the map and by the detail panel, which draw the
// same emblem at very different sizes.
function emblemFilterFactory(defs, prefix) {
  const made = new Map();
  return (hex) => {
    const key = hex || '-';
    if (made.has(key)) return made.get(key);
    const id = `${prefix}-${made.size}`;
    const filt = svgEl('filter', {
      id, 'color-interpolation-filters': 'sRGB',
      x: '0', y: '0', width: '100%', height: '100%',
    });
    const [er, eg, eb] = emblemInk(hex);
    filt.appendChild(svgEl('feColorMatrix', {
      type: 'matrix',
      values: `0 0 0 0 ${er.toFixed(4)}  0 0 0 0 ${eg.toFixed(4)}`
        + `  0 0 0 0 ${eb.toFixed(4)}  0 0 0 1 0`,
    }));
    defs.appendChild(filt);
    made.set(key, id);
    return id;
  };
}

// Draws the stack into one box. A flip is a mirror about the box's own
// centre, which is why the translate is twice the edge plus the span.
function paintEmblem(parent, layers, box, filterFor) {
  for (const layer of layers) {
    const im = svgEl('image', {
      class: 'claim-emblem', href: layer.src, filter: `url(#${filterFor(layer.hex)})`,
      x: box.x, y: box.y, width: box.w, height: box.h,
    });
    im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', layer.src);
    if (layer.flipH || layer.flipV) {
      im.setAttribute('transform',
        `translate(${layer.flipH ? 2 * box.x + box.w : 0}`
        + ` ${layer.flipV ? 2 * box.y + box.h : 0})`
        + ` scale(${layer.flipH ? -1 : 1} ${layer.flipV ? -1 : 1})`);
    }
    parent.appendChild(im);
  }
}

// Everything the emblem needs, resolved together. Keyed by guild and
// kept as the promise rather than the answer, so six markers held by the
// same guild share one request instead of racing to make six.
const emblemPending = new Map();

function guildEmblem(guildId) {
  if (!emblemPending.has(guildId)) {
    // true: the stored copy is good enough here. This draws a badge
    // the size of a thumbnail, and the emblem on it has not changed
    // since the guild was founded.
    const pending = Promise.all([getGuildInfo(guildId, true), getEmblemPieces()])
      .then(([info, pieces]) => ({ info, layers: emblemLayers(info, pieces) }));
    // Dropped again if it fails, so the next marker can retry. Keeping a
    // rejected promise here blanked that guild's emblem for the rest of
    // the session over one bad request.
    pending.catch(() => emblemPending.delete(guildId));
    emblemPending.set(guildId, pending);
  }
  return emblemPending.get(guildId);
}

const sectorsRefreshed = new Set();

// Same deal as the catalogue: the drawing already happened, this is for
// the next one.
function refreshSectorsSoon(mapId) {
  if (sectorsRefreshed.has(mapId)) return;
  sectorsRefreshed.add(mapId);
  fetchJsonCached(
    `${API_BASE}/continents/2/floors/3/regions/7/maps/${encodeURIComponent(mapId)}/sectors?ids=all`)
    .then((list) => {
      const arr = (Array.isArray(list) ? list : []).filter((x) => Array.isArray(x.bounds));
      if (arr.length) sectorCache.set(mapId, arr);
    })
    .catch(() => { sectorsRefreshed.delete(mapId); });
}

async function getSectors(mapId) {
  if (sectorCache.has(mapId)) return sectorCache.get(mapId);
  const pack = staticPack();
  const baked = pack && pack.sectors && pack.sectors[String(mapId)];
  if (Array.isArray(baked) && baked.length) {
    sectorCache.set(mapId, baked);
    refreshSectorsSoon(mapId);
    return baked;
  }
  const list = await fetchJsonCached(
    `${API_BASE}/continents/2/floors/3/regions/7/maps/${encodeURIComponent(mapId)}/sectors?ids=all`);
  const arr = (Array.isArray(list) ? list : []).filter((x) => Array.isArray(x.bounds));
  // Only a real answer is worth keeping, the same rule getGuildInfo
  // follows. An empty one cached would blank that map for the rest of the
  // session, with nothing to retry against short of a reload.
  if (arr.length) sectorCache.set(mapId, arr);
  return arr;
}

function flippedAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Tier is not in the objective data - it is how many upgrade steps the
// yaks have paid for. yaks_required is the cost of one step and not the
// running total, which is why this sums as it goes: a tower's steps cost
// 15, 20 and 35, so fortified is 70 yaks, not 35.
function objectiveTier(meta, ob) {
  const line = upgradeCatalogue && upgradeCatalogue.get(meta.upgrade_id);
  if (!line || !Array.isArray(line.tiers)) return null;
  const yaks = Number(ob.yaks_delivered || 0);
  // yaks_required is what THAT tier costs, not the running total, so the
  // thresholds have to be summed: a tower is 15, then 20, then 35, which
  // is a tier at 15, 35 and 70 delivered.
  let spent = 0;
  let reached = 0;
  let floor = 0;
  let next = null;
  for (const t of line.tiers) {
    const at = spent + Number(t.yaks_required || 0);
    if (yaks >= at) { reached += 1; floor = at; }
    else if (!next) next = { name: t.name, at };
    spent = at;
  }
  return {
    tier: reached,
    tiers: line.tiers,
    name: reached ? line.tiers[reached - 1].name : null,
    yaks,
    floor,
    next,
  };
}

// Where each waypoint stands, in the objectives' own coordinates, taken
// from the points of interest the API publishes - the permanent ones; the
// "Emergency Waypoint" entries belong to the tactic and come and go.
// Baked in rather than fetched: four more requests on open for something
// that has not moved in years. x, y and the point's own id, which is what
// a chat link is made of - see waypointChat.
const WAYPOINT_AT = Object.freeze({
  // Eternal Battlegrounds
  '38-1': [10836.5, 13669.2, 1214], '38-2': [11554.7, 15223.9, 1215],
  '38-3': [9648.4, 15184.7, 1216], '38-9': [10621.7, 14619.2, 1213],
  // Desert Borderlands
  '1099-106': [9492.8, 10632.5, 2221], '1099-113': [10774.6, 10071.3, 2301],
  '1099-114': [12032.4, 10704.6, 2150],
  // Alpine Borderlands, blue and green
  '96-32': [15173.9, 12869.5, 1239], '96-33': [13083.0, 12921.3, 1235],
  '96-37': [14013.8, 12465.6, 1237],
  '95-32': [8005.9, 13509.5, 1245], '95-33': [5915.0, 13561.3, 1241],
  '95-37': [6845.8, 13105.6, 1243],
});

// The game's own chat link for a point of interest: the byte 4, then the
// id as four little-endian bytes, base64'd between [& and ]. Built here
// rather than written out, because a wrong character in a pasted code is
// a link that silently goes nowhere.
function waypointChat(poiId) {
  if (!poiId) return null;
  const b = [4, poiId & 255, (poiId >> 8) & 255, (poiId >> 16) & 255, (poiId >> 24) & 255];
  return `[&${btoa(String.fromCharCode(...b))}]`;
}

// Straight to the clipboard, with the old way behind it: the modern API
// needs a secure context and the user's permission, and neither is
// guaranteed.
function copyChatLink(text) {
  const legacy = () => {
    try { return typeof legacyCopy === 'function' ? legacyCopy(text) : false; }
    catch { return false; }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, legacy);
  }
  return Promise.resolve(legacy());
}

// Eternal Battlegrounds, placed by eye rather than by bearing. The real
// bearings there are 100, 141, 151 and 158 degrees - every one straight
// into the claim badge - so the rule had nowhere to put them and stacked
// all four in the same corner. Offsets are in units of the marker's own
// radius, x right and y down.
const WAYPOINT_NUDGE = Object.freeze({
  // Overlook, red's keep. Tucked in until it just laps the icon's edge -
  // the disc is 1r and this badge 0.37r across, so at this height the
  // two overlap by about four hundredths of a radius.
  '38-1': [-1.00, 0.74],
  // Valley, blue's keep.
  '38-2': [-1.08, 0.64],
  // Lowlands, green's keep. Clear of the tier shields, which stop at
  // 0.76r across, and clear of the claim badge, which starts at 0.09r
  // down.
  '38-3': [1.32, -0.44],
  // Stonemist. Low and left, which is the one quarter the claim badge
  // never reaches.
  '38-9': [-0.86, 0.78],
});

// Whose map is this. A borderland says so in its own name; Eternal
// Battlegrounds does not, and nothing the API publishes ties its three
// keeps to a colour, so they are listed - they have not moved since
// 2012. The wiki names the sectors Red, Blue and Green World, and across
// nine live matchups each keep was held by that colour 9/9, 9/9 and 8/9,
// while Stonemist split 5/2/2 the way a keep nobody owns by default
// does.
const BL_HOME_COLOR = Object.freeze({ RedHome: 'red', BlueHome: 'blue', GreenHome: 'green' });
const EBG_HOME_KEEP = Object.freeze({ '38-1': 'red', '38-2': 'blue', '38-3': 'green' });

// Does this objective have a waypoint? Not a field the API publishes,
// and - this is the trap - not something the upgrade catalogue still
// gets right either: it says "Build Waypoint" is a Fortified upgrade,
// which stopped being true with the 24/02/2026 notes. A home team's own
// keep now has one at any tier, tier 0 included, and the catalogue only
// answers for the other two cases - a keep an enemy took, and Stonemist.
//
// It says the waypoint EXISTS, not that you can use it: one that is
// contested is not published at all.
function hasWaypoint(mapType, ob, tierInfo) {
  if (ob && ob.type === 'Keep') {
    const home = BL_HOME_COLOR[mapType] || EBG_HOME_KEEP[ob.id];
    if (home && String(ob.owner || '').toLowerCase() === home) return true;
  }
  if (!tierInfo || !tierInfo.tier) return false;
  for (let i = 0; i < tierInfo.tier; i++) {
    const t = tierInfo.tiers[i];
    for (const up of (t && t.upgrades) || []) {
      if (/waypoint/i.test(up.name || '')) return true;
    }
  }
  return false;
}

// Held off to the side, in the direction the waypoint really lies. A
// fixed corner was the obvious first try and it put Ascension Bay's out
// over the water, because a corner is the same guess for every keep on
// the map. Only the bearing is kept, not the distance: most waypoints
// sit closer than the marker's own radius, so drawn to scale the badge
// would land underneath the icon it belongs to.
function waypointBadge(r, p) {
  const w = r * 0.74;
  const g = svgEl('g', { class: 'wvw-wp' });
  const chat = waypointChat((WAYPOINT_AT[p.meta.id] || [])[2]);

  const put = (cx, cy) => {
    const im = svgEl('image', {
      href: 'assets/icons/Waypoint.webp',
      x: cx - w / 2, y: cy - w / 2, width: w, height: w,
    });
    im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href',
      'assets/icons/Waypoint.webp');
    g.appendChild(im);

    const tip = svgEl('title', {});
    tip.textContent = chat
      ? 'Waypoint \u2014 click to copy its chat link, then paste it in game'
      : 'Waypoint \u2014 contested while the objective is under attack';
    g.appendChild(tip);

    if (chat) {
      g.classList.add('is-copyable');
      g.addEventListener('click', (e) => {
        // The badge sits inside the marker's group, so without this a
        // copy would also select the objective behind it.
        e.stopPropagation();
        copyChatLink(chat).then((ok) => {
          const note = svgEl('text', {
            class: 'wvw-wp-note', x: cx, y: cy - w * 0.8,
            'font-size': r * 0.5, 'text-anchor': 'middle',
          });
          note.textContent = ok ? 'copied' : chat;
          g.appendChild(note);
          setTimeout(() => note.remove(), 1400);
        });
      });
    }
    return g;
  };

  const fixed = WAYPOINT_NUDGE[p.meta.id];
  if (fixed) return put(fixed[0] * r, fixed[1] * r);

  const at = WAYPOINT_AT[p.meta.id];
  let dx = -1, dy = -1;
  if (at) { dx = at[0] - p.x; dy = at[1] - p.y; }
  const d = Math.hypot(dx, dy) || 1;

  // Bearing, clockwise from straight up, to be checked against what is
  // already parked around the marker: the tier shields hold the top from
  // -46 to 46 degrees and reach about 1.0r, and the claim badge sits at
  // 133 degrees with a box that runs out to roughly 1.8r.
  let a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  let out = Math.min(Math.max(d, r * 1.22), r * 1.7);

  if (a < 45 || a > 315) {
    // Above the shields. Pushing outward keeps the real bearing, and
    // there is nothing further up to run into.
    out = Math.max(out, r * 1.55);
  } else if (a > 95 && a < 190) {
    // Straight into the claim badge, which is where all four Eternal
    // Battlegrounds waypoints really lie. Clearing a box that deep would
    // strand the icon next to another marker, so it gives up the bearing
    // and takes the upper left, the one corner nothing else uses.
    a = 315;
    out = r * 1.5;
  }

  const rad = (a * Math.PI) / 180;
  return put(Math.sin(rad) * out, -Math.cos(rad) * out);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

// The heraldic shield both badges are cut from: flat across the top,
// straight down the sides, then curving in to a point. Centred on
// (cx, cy) so callers can place it by where it should sit rather than
// by a corner.
function shieldPath(cx, cy, w, h, cls) {
  const x = cx - w / 2, y = cy - h / 2;
  return svgEl('path', {
    class: cls,
    d: `M${x} ${y}h${w}v${h * 0.5}`
      + `q0 ${h * 0.32} ${-w / 2} ${h * 0.5}`
      + `q${-w / 2} ${-h * 0.18} ${-w / 2} ${-h * 0.5}z`,
  });
}


// ---- the fight log --------------------------------------------------
// What puts the crossed swords on a map tab. Which map is busy cannot be
// read from one answer: the API publishes kills only as running totals
// for the week, so a map that was a warzone at breakfast still carries
// the number at midnight. It takes two readings, apart in time.
//
// The standings already fetch wvw/matches every five minutes, and that
// answer carries maps[].kills - so every refresh drops a snapshot here on
// its way past and the popover compares now against one already waiting.
// No extra request, and the cadence is untouched. It survives a reload; a
// first-ever visit has no history, and the swords stay off until two
// samples exist. The other half comes from the kills sheet, whose format
// is this project's own - see KILLS_SHEET_ID in js/config.js.
const FIGHT_KEY = 'wvw-fight-v1';
const FIGHT_KEEP_MS = 40 * 60 * 1000;
const FIGHT_MAX_SAMPLES = 12;
const FIGHT_MIN_GAP_MS = 60 * 1000;
// A sample older than this is not a baseline, it is history. Guards
// against a dead sheet: its rows would keep ageing and the rate computed
// off them would look plausible and be meaningless.
const FIGHT_STALE_MS = 3 * 60 * 60 * 1000;

// Player kills per map, and only those. deaths look like the same measure
// and are not: summed over the three sides they also count everyone who
// died to a lord, a guard or a fall - a roamer soloing a camp, which is
// the opposite of what the swords are for. Measured across thirty-six
// live maps, deaths run 0.9% above kills on a busy map and 18.6% above on
// an empty borderland, so counting them would lift exactly the map nobody
// wants to be sent to.
function fightTotals(match) {
  const out = {};
  for (const m of (match && match.maps) || []) {
    let n = 0;
    for (const c of COLORS) n += Number((m.kills || {})[c] || 0);
    out[m.type] = n;
  }
  return out;
}

function readFightLog() {
  // A private window, cleared site data or a browser set to block
  // storage all throw here rather than returning null.
  try {
    const raw = localStorage.getItem(FIGHT_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// Called by whoever happens to be holding fresh match data, with `asked`:
// when the request went out. A body is stamped with that, not with the
// moment it is written - a slow answer or a sleeping computer would
// otherwise carry the time of the waking up. Only bodies whose score this
// page watched rise since `asked` are written: a first sight may come from
// a server behind the others and would become the window's base. Cheap enough to call on every
// refresh, and it declines samples that arrive too close together so the
// popover's own thirty-second poll cannot flood it.
function recordFightSamples(matches, asked) {
  const log = readFightLog();
  const now = Date.now();
  const seen = new Set();
  for (const match of matches || []) {
    if (!match || typeof match.id !== 'string' || !Array.isArray(match.maps)) continue;
    seen.add(match.id);
    // Ageing counts from the real now, not from `asked`.
    const kept = (log[match.id] || []).filter((s) => s && now - s.at <= FIGHT_KEEP_MS);
    const newest = newestMatches.get(match.id);
    const last = kept[kept.length - 1];
    // A negative gap (an answer overtaken by a later one) is refused too.
    if (newest && newest.rose && newest.at >= asked && now - asked <= FIGHT_KEEP_MS
      && (!last || asked - last.at >= FIGHT_MIN_GAP_MS)) kept.push({ at: asked, n: fightTotals(match) });
    log[match.id] = kept.slice(-FIGHT_MAX_SAMPLES);
  }
  // Matches this call did not mention are only dropped once they age out,
  // not immediately: the maps popover records a single match at a time
  // and must not wipe the other eight.
  for (const id of Object.keys(log)) {
    if (seen.has(id)) continue;
    const kept = log[id].filter((s) => s && now - s.at <= FIGHT_KEEP_MS);
    if (kept.length) log[id] = kept; else delete log[id];
  }
  try { localStorage.setItem(FIGHT_KEY, JSON.stringify(log)); } catch { /* storage off */ }
}


// The shared half of the fight log: snapshots taken whether or not anyone
// was looking - half an hour from this project's API, two hours from the
// sheet when that fails - which is the only way a first-ever visitor
// can be told which map is busy. Cached, so tab switches and the
// thirty-second poll never refetch it.
let killSheet = null;
let killSheetAt = 0;
let killSheetInFlight = null;

// A match whose only age is "first seen here" is backdated to the history's
// newest line for it, so opening during a freeze is amber at once. Only when
// the history itself is alive: a general freeze and a stopped trigger look
// the same from here, and without certainty nothing is claimed. A body
// with fewer kills than the history's newest line is backdated either way.
const HISTORY_LIVE_MS = 10 * 60 * 1000;

function ageFromHistory(byMatch) {
  if (!(byMatch instanceof Map)) return;
  ageBehindHistory(byMatch, fightTotals);
  const now = Date.now();
  let alive = false;
  for (const list of byMatch.values()) {
    const last = list && list[list.length - 1];
    if (last && now - last.at <= HISTORY_LIVE_MS) { alive = true; break; }
  }
  if (alive) ageFirstSightFromHistory(byMatch, HUD_STALE_MS);
}

async function getKillSheet() {
  if (killSheet && Date.now() - killSheetAt < KILLS_SHEET_TTL_MS) return killSheet;
  if (killSheetInFlight) return killSheetInFlight;

  killSheetInFlight = (async () => {
    try {
      killSheet = await readOwnKills().catch(readKillSheet);
      killSheetAt = Date.now();
      ageFromHistory(killSheet);
    } catch {
      // The local log still answers for anyone who has been here a
      // while; only the cold visit loses out, and it loses quietly.
      if (!killSheet) killSheet = new Map();
    }
    killSheetInFlight = null;
    return killSheet;
  })();
  return killSheetInFlight;
}

// One reading into the map both sources fill: match id to samples.
function addKillSample(by, at, id, counts) {
  if (!Number.isFinite(at) || !at || !id) return;
  const n = {};
  KILLS_MAP_ORDER.forEach((t, i) => { n[t] = Number(counts[i]) || 0; });
  if (!by.has(id)) by.set(id, []);
  by.get(id).push({ at, n });
}

function sortKillSamples(by) {
  for (const list of by.values()) list.sort((a, b) => a.at - b.at);
  return by;
}

// The last thirty minutes, as [at, match, Center, RedHome, BlueHome,
// GreenHome] - the sheet's columns, as numbers. An empty answer is a
// failure too: the Worker says 503 when its copy stops moving, and nothing
// at all is no better.
async function readOwnKills() {
  const data = await fetchOwnApi(OWN_KILLS_URL);
  const rows = data && data.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows');
  const by = new Map();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2 + KILLS_MAP_ORDER.length) continue;
    addKillSample(by, Number(r[0]), typeof r[1] === 'string' ? r[1] : '', r.slice(2));
  }
  if (!by.size) throw new Error('no usable rows');
  return sortKillSamples(by);
}

async function readKillSheet() {
  // The deadline every other request on this page already gets. A
  // connection that accepts and then goes quiet would leave this
  // pending for good - and killSheetInFlight hands that same promise to
  // every later caller, so the shared history would be gone for the
  // rest of the session with nothing having failed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(KILLS_SHEET_URL,
      { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const by = new Map();
    for (const r of parseCsv(await res.text())) {
      if (!r || r.length < 2 + KILLS_MAP_ORDER.length) continue;
      addKillSample(by, Number(r[0]), String(r[1] || ''), r.slice(2));
    }
    return sortKillSamples(by);
  } finally {
    clearTimeout(timer);
  }
}

// Both halves as one series. The sheet covers the cold visit at
// five-minute resolution, localStorage covers an open session at thirty
// seconds; sorted together, picking a baseline never has to care which
// is which. Only the match's own week: kills restart at the reset, and a
// line from last week as a baseline would read as no fight at all.
function fightSamples(match) {
  const id = match && match.id;
  const local = readFightLog()[id] || [];
  const shared = (killSheet && killSheet.get(id)) || [];
  // Anything older than this is thrown away rather than used as a
  // baseline. If the sheet's trigger ever dies, its newest row keeps
  // ageing, and a rate measured over three days would be a number that
  // looks real and means nothing. Better to show no swords at all.
  const week = Date.parse(match && match.start_time);
  const floor = Math.max(Date.now() - FIGHT_STALE_MS, Number.isFinite(week) ? week : 0);
  return [...shared, ...local]
    .filter((s) => s && s.at >= floor)
    .sort((a, b) => a.at - b.at);
}

// When a match's kills last moved: the time of the first reading - the
// shared history, this browser's log, or the body in hand - whose total over
// the four maps had reached the newest total. The API moves the four in the
// same answer, so it is one clock per match. The body counts as a reading
// from when this page first saw its total, not from every repaint.
const killFirstSeen = new Map(); // match id -> { total, at }

// Silence that is still ordinary: the API's kills move up to about five
// minutes after a score tick, plus half a minute.
const KILLS_QUIET_MS = 5.5 * 60 * 1000;
// Past that, the time the match takes to make this many kills at its own
// pace in the window: silent longer, and the kills are late, not the map
// quiet. D1, 30/09-03/10/2026: no false alarm in 518 silences, 501 of 513
// stops flagged before the kills came back.
const KILLS_LATE_KILLS = 15;
// A step that lands after more than this of still kills is the source
// catching up: when it happened is unknown, so it lights no swords until the
// next step (replay of 03/10/2026 12:41-14:13: 52 -> 0 swords on stopped kills).
const KILLS_CATCHUP_MS = 10 * 60 * 1000;

function sumKills(n) {
  let t = 0;
  for (const k in n) t += Number(n[k]) || 0;
  return t;
}

// Which map is busy, and how much the corner may say, in one place: the
// map's corner, the tab's swords and the tier button's badge all read this,
// so they cannot part. Ten minutes back is what the window aims for: long
// enough that one gank does not decide it, short enough that "busy" still
// means now. `types`: the maps to pick from, in the order a tie keeps.
//   clock    ms when the match's kills reached their newest total; 0, none
//   atLeast  the clock is the week's oldest reading: nothing known before it
//   silence  ms since the clock
//   prevRun  ms the total before the newest stood still; Infinity, unknown
//   rates    { per: type -> kills per 10 min, span }, over the window that
//            ends at the clock; null without a reading 10 min before it (a
//            dash, never 0: a shorter span can hold no step of the kills)
//   pace     the match's kills per minute in that window; 0 without one
//   strange  silent past KILLS_QUIET_MS plus KILLS_LATE_KILLS at that pace
//   frozen   the score itself still past HUD_STALE_MS (the corner's amber)
//   hot      the map with the orange swords, or null
const HOT_WANT_MS = 10 * 60 * 1000;
const HOT_NOW_MS = 60 * 1000;  // a kept body this fresh paints the swords without waiting for the read
const HOT_FLOOR = 50;      // kills per ten minutes: a real fight, not API noise

function killView(match, types, now = Date.now()) {
  const view = { clock: 0, atLeast: false, silence: 0, prevRun: Infinity, rates: null, pace: 0,
    strange: false, frozen: false, hot: null };
  // Nothing is claimed on a match that is not running: between the reset
  // and the API publishing the new one, the rest of the popover is neutral.
  if (!match || !matchIsLive(match)) return view;
  const rose = matchScoreRoseAt(match.id);
  view.frozen = now - rose > HUD_STALE_MS;

  const list = fightSamples(match);
  const body = fightTotals(match);
  const bodyTotal = sumKills(body);
  const series = list.map((s) => ({ at: s.at, total: sumKills(s.n) }));
  const listTop = series.reduce((m, s) => Math.max(m, s.total), 0);
  if (!series.length || bodyTotal > listTop) {
    let seen = killFirstSeen.get(match.id);
    if (!seen || seen.total !== bodyTotal) {
      seen = { total: bodyTotal, at: now };
      killFirstSeen.set(match.id, seen);
    }
    // A body's kills are as old as its score: one body carries both.
    series.push({ at: rose > 0 ? Math.min(seen.at, rose) : seen.at, total: bodyTotal });
    series.sort((a, b) => a.at - b.at);
  }
  const top = Math.max(bodyTotal, listTop);
  const first = series.findIndex((s) => s.total >= top);
  view.clock = series[first].at;
  view.atLeast = first === 0;
  view.silence = Math.max(0, now - view.clock);
  if (first > 0) {
    const before = series[first - 1].total;
    view.prevRun = view.clock - series.find((s) => s.total >= before).at;
  }

  let base = null;
  for (const s of list) if (s.at <= view.clock - HOT_WANT_MS) base = s;
  if (base) {
    const span = view.clock - base.at;
    const per = new Map();
    let moved = 0;
    for (const type in body) {
      // Inside a week kills only rise: the highest reading of a map is its newest.
      let high = body[type];
      for (const s of list) high = Math.max(high, Number(s.n[type]) || 0);
      const d = Math.max(0, high - (Number(base.n[type]) || 0));
      moved += d;
      per.set(type, d * (600000 / span));
    }
    if (moved) {
      view.rates = { per, span };
      view.pace = moved / (span / 60000);
    }
  }
  if (view.pace > 0) {
    view.strange = view.silence > KILLS_QUIET_MS + (KILLS_LATE_KILLS / view.pace) * 60000;
  }

  if (view.rates && !view.strange && !view.frozen && view.silence <= HOT_WANT_MS
    && view.prevRun <= KILLS_CATCHUP_MS) {
    const pick = types || MAP_PANEL_ORDER.filter((t) => (match.maps || []).some((m) => m.type === t));
    let bestN = 0;
    // Taken on a strict win, so a tie keeps whichever map comes first rather
    // than swapping the swords on every refresh.
    for (const type of pick) {
      const n = view.rates.per.get(type) || 0;
      if (n > bestN) { bestN = n; view.hot = type; }
    }
    if (bestN < HOT_FLOOR) view.hot = null;
  }
  return view;
}

// killView's pick and window, under the name the tab and the badge call.
function hotMapOf(match, types) {
  const view = killView(match, types);
  return { hot: view.hot, rates: view.rates, view };
}

// The kills a map shows over the span of its window. The tab's title and
// the corner read it through this one function, so the figures cannot part.
function fightCount(rates, type) {
  return {
    kills: Math.round((rates.per.get(type) || 0) * rates.span / 600000),
    mins: Math.round(rates.span / 60000),
  };
}

// Past this, the corner stops calling the map "updated" and says how long
// its data has not moved, frozen or unanswered: one 5-min score tick
// missed, plus a minute. Not less: a low tier at night was never measured.
const HUD_STALE_MS = 6 * 60 * 1000;

const HUD_EXPLAIN = {
  fights: 'Player kills on this map in the last 10 minutes. Orange swords mark the busiest map, past 50.',
  when: "Updated: when this match's score last changed in the game's API; this page"
    + ' asks every 30 s. The API sometimes repeats an old answer for a while; that does not'
    + ' count. No new data: no change for over 6 minutes, or no answer at all (the API stuck,'
    + ' your internet, or a sleeping computer), so what you see may be old.'
    + " The game's API itself runs about 40 s behind the game.",
};

// The two corners over the map: kills on the left, on the right the age
// of the match's data (matchScoreRoseAt). Text on a shadow, no box, so
// the map shows through; they go while the map is zoomed, as the score bar's smear would
// cover what the visitor came to look at. Built once per map; paint()
// rewrites them in place, so the status region keeps its identity.
function buildMapCorners(wrap) {
  const svg = wrap.querySelector('.wvw-plot');
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const note = mk('p', 'wvw-hud-note');
  note.id = `wvw-hud-note-${++plotSerial}`;
  note.hidden = true;
  let openKey = null;
  let fightsExplain = HUD_EXPLAIN.fights;
  const hover = window.matchMedia && matchMedia('(hover: hover)').matches;
  const close = () => {
    openKey = null;
    note.hidden = true;
    for (const b of wrap.querySelectorAll('.wvw-hud-btn')) b.setAttribute('aria-expanded', 'false');
  };
  note.addEventListener('click', (e) => { e.stopPropagation(); close(); });

  // One text for the hover title and the touch balloon.
  const corner = (side, key, btn) => {
    const box = mk('div', `wvw-hud wvw-hud-${side}`);
    btn.type = 'button';
    btn.className = 'wvw-hud-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', note.id);
    if (hover) btn.title = key === 'fights' ? fightsExplain : HUD_EXPLAIN[key];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = openKey === key;
      close();
      if (was) return;
      openKey = key;
      note.textContent = key === 'fights' ? fightsExplain : HUD_EXPLAIN[key];
      note.className = `wvw-hud-note at-${side}`;
      note.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    btn.addEventListener('keydown', (e) => {
      // Closes the balloon, not the popover behind it.
      if (e.key === 'Escape' && openKey) { e.stopPropagation(); close(); }
    });
    box.appendChild(btn);
    box.hidden = true;
    return box;
  };

  const swords = mk('img');
  swords.src = 'assets/icons/Event_Swords.webp';
  swords.alt = '';
  swords.width = 18;
  swords.height = 18;
  const big = mk('span', 'wvw-hud-big');
  const small = mk('span', 'wvw-hud-small');
  const smallMins = mk('span');
  const smallLong = mk('span', 'wvw-hud-long');
  const smallShort = mk('span', 'wvw-hud-short');
  const smallMark = mk('span');
  const smallUntil = mk('span');
  const smallTime = mk('time');
  const smallTail = mk('span');
  smallTail.append(' \u00b7 ', smallMark, smallMins, smallLong, smallShort, smallUntil, smallTime);
  small.append('kills', smallTail);
  const fightsBtn = mk('button');
  const txt = mk('span', 'wvw-hud-txt');
  txt.append(big, small);
  fightsBtn.append(swords, txt);
  const left = corner('l', 'fights', fightsBtn);

  const ago = mk('time', 'wvw-hud-ago');
  const mark = mk('span', 'wvw-hud-mark');
  const word = mk('span', 'wvw-hud-word');
  const val = mk('span');
  const unitLong = mk('span', 'wvw-hud-long');
  const unitShort = mk('span', 'wvw-hud-short');
  ago.append(mark, word, val, unitLong, unitShort);
  const whenBtn = mk('button');
  whenBtn.appendChild(ago);
  // Spoken only when the state turns, not every second.
  const live = mk('span', 'wvw-hud-live');
  live.setAttribute('role', 'status');
  const right = corner('r', 'when', whenBtn);
  right.appendChild(live);

  wrap.append(left, right, note);

  const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const putTime = (ms) => {
    put(smallTime, ms ? hhmm(ms) : '');
    if (ms) smallTime.dateTime = new Date(ms).toISOString(); else smallTime.removeAttribute('datetime');
  };
  // The kills side, from killView for the map on show. No window, a dash and
  // only "kills": never 0, which would say nobody fought. One line, three looks:
  // current ("80 kills \u00b7 10 min"); old for a normal reason, the quiet of a
  // slow map ("\u00b7 until HH:MM", the kills' own clock); old for an abnormal one,
  // the API behind or the map frozen ("\u00b7 \u26a0 until HH:MM", the number dimmed:
  // the sign and the word are the signal, not the colour).
  const paintKills = (view, type, isStale) => {
    const rates = view && view.rates;
    const line = rates && type ? fightCount(rates, type) : null;
    put(big, line ? String(line.kills) : '\u2013');
    smallTail.hidden = !line;
    const odd = !!line && !!view.clock && (isStale || !!view.strange);
    const old = !!line && !!view.clock && (odd || view.silence > KILLS_QUIET_MS);
    left.classList.toggle('is-dim', odd);
    put(smallMins, line && !old ? String(line.mins) : '');
    put(smallLong, line && !old ? ' min' : '');
    put(smallShort, line && !old ? 'm' : '');
    put(smallMark, odd ? '\u26a0 ' : '');
    put(smallUntil, old ? 'until ' : '');
    putTime(old ? view.clock : 0);
    let text;
    if (!line) {
      text = 'Not enough kill data yet to count 10 minutes.';
    } else if (odd) {
      text = `The game's API is behind since ${hhmm(view.clock)}, so this number is old.`;
    } else if (old) {
      text = `No new kills since ${hhmm(view.clock)}, as on a quiet map. The number is the 10 minutes before.`;
    } else {
      text = HUD_EXPLAIN.fights;
    }
    if (text === fightsExplain) return;
    fightsExplain = text;
    if (hover) fightsBtn.title = text;
    if (openKey === 'fights') note.textContent = text;
  };
  let stale = null;
  const state = {
    // view: killView's answer for this match (null before one); type: the
    // map on show; at: ms the score last rose, 0 if unknown. The kills show
    // whenever the age does.
    paint(view, type, at) {
      left.hidden = !at;
      right.hidden = !at;
      if (!at) { paintKills(view, type, false); stale = null; return; }
      const age = Math.max(0, Date.now() - at);
      const isStale = age > HUD_STALE_MS;
      paintKills(view, type, isStale);
      ago.classList.toggle('is-stale', isStale);
      ago.dateTime = new Date(at).toISOString();
      const mins = Math.floor(age / 60000);
      // Past the limit the word and the sign are the signal, never the
      // colour alone; narrow drops the word and keeps the sign.
      put(mark, isStale ? '\u26a0 ' : '');
      put(word, isStale ? 'No new data \u00b7 ' : 'Updated ');
      if (isStale) {
        put(val, String(mins));
        put(unitLong, ' min');
        put(unitShort, ' min');
      } else if (mins < 1) {
        put(val, `${Math.floor(age / 1000)}s`);
        put(unitLong, ' ago');
        put(unitShort, ' ago');
      } else {
        put(val, String(mins));
        put(unitLong, ' min ago');
        put(unitShort, 'm ago');
      }
      if (stale !== null && stale !== isStale) {
        put(live, isStale ? `No new map data for ${mins} min` : 'New map data again');
      }
      stale = isStale;
    },
  };

  if (svg && window.MutationObserver) {
    const full = svg.viewBox.baseVal.width;
    new MutationObserver(() => {
      const zoomed = svg.viewBox.baseVal.width < full * 0.98;
      wrap.classList.toggle('is-zoomed', zoomed);
      if (zoomed) close();
    }).observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
  }
  return state;
}

// ---- Righteous Indignation ------------------------------------------
// Five minutes, from the wiki, on every objective but sentries. During it
// the guards cannot be hurt, so it answers "can I take it back yet"
// rather than "who owns this".
const RI_MS = 5 * 60 * 1000;

function riLeft(iso) {
  if (!iso) return 0;
  const end = new Date(iso).getTime() + RI_MS;
  const left = end - Date.now();
  return Number.isFinite(left) && left > 0 ? left : 0;
}

function riClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Crossed swords and a countdown, under the marker. The group carries
// its own expiry in a data attribute rather than being held in a list,
// so the one-second tick can just sweep the DOM - no registry to keep in
// step with a repaint that rebuilds every marker from scratch.
function riBadge(r, ob) {
  // Ruins are left out. They have no guards, so there is nothing for
  // five minutes of invulnerability to protect - and they turn over
  // constantly, so the badges would be permanent clutter strung across
  // the middle of every borderland.
  if (!ob || ob.type === 'Ruins') return null;
  const left = riLeft(ob.last_flipped);
  if (!left) return null;
  const g = svgEl('g', { class: 'wvw-ri' });
  g.dataset.until = String(new Date(ob.last_flipped).getTime() + RI_MS);
  // Its own words now that it can be hovered. No number in them: this is
  // written on the thirty-second repaint while the clock beside it ticks
  // every second, and a tooltip two minutes behind would be worse than
  // none.
  const tip = svgEl('title', {});
  tip.textContent = 'Righteous Indignation \u2014 just flipped, and its'
    + ' guards take no damage until this runs out';
  g.appendChild(tip);

  g.appendChild(svgEl('rect', {
    x: -r * 1.3, y: r * 1.05, width: r * 2.6, height: r * 0.95,
    rx: r * 0.475,
  }));
  const im = svgEl('image', {
    href: 'assets/icons/Event_Swords.webp', x: -r * 1.16, y: r * 1.15,
    width: r * 0.75, height: r * 0.75,
  });
  im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href',
    'assets/icons/Event_Swords.webp');
  g.appendChild(im);

  const t = svgEl('text', {
    x: -r * 0.3, y: r * 1.525, 'font-size': r * 0.68,
    'dominant-baseline': 'central',
  });
  t.textContent = riClock(left);
  g.appendChild(t);
  return g;
}

// Rewrites the clocks and drops the badges whose five minutes are up.
// Text only - it fetches nothing, which is why it can run every second
// alongside the thirty-second refresh without competing with it.
function tickRi(root) {
  for (const g of root.querySelectorAll('.wvw-ri')) {
    const left = Number(g.dataset.until) - Date.now();
    if (!(left > 0)) { g.remove(); continue; }
    const t = g.querySelector('text');
    if (t) t.textContent = riClock(left);
  }
}

// The guild's own emblem on a gold shield at the marker's lower left,
// which is how a claimed objective reads in game - larger than the tier
// shields above it, so claimed and upgraded never get confused. The
// shield is drawn straight away and the emblem drops in when the lookup
// lands, so a slow guild call never holds up the map.
function claimBadge(r, guildId, emblemFilter) {
  // Lower right, measured off the game - but pulled in over the disc
  // rather than hung off its corner, and smaller with it. Sitting a full
  // radius out on both axes it read as a second object parked beside the
  // marker instead of a badge on it.
  const w = r * 1.12, h = w * 1.06;
  const cx = r * 0.74, cy = r * 0.68;
  const g = svgEl('g', { class: 'wvw-claim' });
  // Two shields, one inside the other: the bright rim and the darker
  // field it frames. That pair is what reads as the game's gold shield
  // at this size - its quartering is under a pixel here.
  g.appendChild(shieldPath(cx, cy, w, h, 'claim-rim'));
  g.appendChild(shieldPath(cx, cy, w * 0.82, h * 0.82, 'claim-field'));
  guildEmblem(guildId).then(({ layers }) => {
    if (!layers.length) return;
    // Bigger than it was. With one flat silhouette there was nothing to
    // make out and the size did not matter; a real emblem has a device
    // inside a backdrop, and at the old two thirds the inner shape was
    // gone.
    paintEmblem(g, layers, {
      x: cx - w * 0.38, y: cy - h * 0.39, w: w * 0.76, h: w * 0.76,
    }, emblemFilter);
  }).catch(() => { /* the shield alone still says claimed */ });
  return g;
}

// One shield per tier along the TOP of the marker, none at tier 0, laid
// out the way the game lays them out: one shield sits dead centre, two
// flank that centre, and three put one back in the centre with the other
// two out on the shoulders. Degrees from straight up.
const TIER_ANGLES = [null, [0], [-24, 24], [-46, 0, 46]];

function tierShields(r, tier) {
  const g = svgEl('g', { class: 'wvw-tierpips' });
  const angles = TIER_ANGLES[tier];
  if (!angles) return g;
  const w = r * 0.42, h = w * 1.15;
  // At w*1.15 tall, a centre of 0.76r lands the top edge of each shield
  // exactly on the outline at 1.0r, so they sit on the icon rather than
  // over its edge. The game's own 1.3 radii floated free of a disc as
  // small as ours.
  const R = r * 0.76;
  for (const a of angles) {
    const t = (a * Math.PI) / 180;
    g.appendChild(shieldPath(Math.sin(t) * R, -Math.cos(t) * R, w, h));
  }
  return g;
}

// One map, drawn. Returns the wrapper plus a redraw hook, so the caller
// can swap maps without rebuilding the whole popover.
function buildMapStage(match, mapData, sectors, catalogue, onSelect) {
  // Who holds what, and only that. Empty means nobody knows yet, which is
  // a real state and not an error: during the relink of 26/09 the API
  // published the new match with the objective lists blank while the maps
  // came up, and a tier that has not turned over yet is still serving
  // last week's owners.
  const ownersOf = (data, isLive) => {
    const byId = new Map();
    if (isLive) for (const ob of (data && data.objectives) || []) byId.set(ob.id, ob);
    return byId;
  };
  let owners = ownersOf(mapData, matchIsLive(match));

  // The markers come from the catalogue, never from the match: what
  // exists on a map and where it sits do not change at a relink, so the
  // map is always whole and ownership is the only thing that waits. An
  // objective with no owner is drawn Neutral.
  const blank = (meta) => ({ id: meta.id, type: meta.type, owner: 'Neutral' });
  const pts = [];
  for (const meta of catalogue.values()) {
    if (meta.map_id !== mapData.id) continue;
    if (MAP_SKIP_TYPES.has(meta.type)) continue;
    // coord, not label_coord. label_coord is where the game writes the
    // objective's *name*, which floats clear of the building so the text
    // stays readable: 111 units off on Eternal Battlegrounds on average,
    // 171 on the Red borderland, 534 at Blistering Undercroft. coord is
    // the structure itself, and all 76 markers the wiki plots for these
    // maps match it to the decimal. The three EBG mercenary camps publish
    // an empty coord; MERC_COORD stands in for them.
    const at = (meta.coord && meta.coord.length) ? meta.coord
      : (MERC_COORD[meta.id] || meta.label_coord);
    if (!at) continue;
    pts.push({ ob: owners.get(meta.id) || blank(meta), meta, x: at[0], y: at[1] });
  }

  // The viewBox comes from the sector outlines, so the drawing defines
  // its own frame and nothing has to agree about map bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sec of sectors) {
    for (const [x, y] of sec.bounds) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const pad = (maxX - minX) * 0.02;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const fullW = maxX - minX, fullH = maxY - minY;

  const wrap = document.createElement('div');
  wrap.className = 'wvw-plot-wrap';

  const svg = svgEl('svg', {
    class: 'wvw-plot',
    viewBox: `${minX} ${minY} ${fullW} ${fullH}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  // One flattening filter per colour actually on this map, built the
  // first time that colour is asked for. The alpha channel passes through
  // untouched, so all that survives of the layer is its shape, filled
  // with the guild's own dye. The count of filtered elements is the same
  // as when they all shared one filter, so this costs no more to draw.
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  const emblemFilter = emblemFilterFactory(defs, `wvw-emblem-${++plotSerial}`);

  // Which side holds the objective inside each sector, so the ground
  // itself can be tinted.
  const ownerBySector = new Map();
  for (const p of pts) {
    if (p.meta.sector_id) ownerBySector.set(p.meta.sector_id, p.ob.owner);
  }
  // Terrain first, everything else on top of it.
  const picture = MAP_IMAGE[mapData.id];
  const terrainAt = (src) => {
    const img = svgEl('image', {
      href: src, x: picture.x, y: picture.y,
      width: picture.w, height: picture.h,
      preserveAspectRatio: 'none',
    });
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', src);
    return img;
  };
  let terrain = null;
  if (picture) {
    terrain = terrainAt(picture.lite);
    svg.appendChild(terrain);
  }

  // Three passes, not one. A single pass lets the next sector's fill paint
  // over the previous one's outline, which is exactly where the border
  // matters most - the line between two owners. The dark pass also buries
  // the pale sector borders printed into the wiki render.
  const land = svgEl('g', { class: picture ? 'over-terrain' : '' });
  const edgeW = (picture && picture.edge) || 14;
  const tinted = [];
  const fills = svgEl('g', { class: 'wvw-fills' });
  const unders = svgEl('g', { class: 'wvw-edges-under', 'stroke-width': edgeW });
  const overs = svgEl('g', { class: 'wvw-edges', 'stroke-width': edgeW * 0.44 });
  for (const sec of sectors) {
    const owner = String(ownerBySector.get(sec.id) || 'neutral').toLowerCase();
    const points = sec.bounds.map(([x, y]) => `${x},${y}`).join(' ');
    const poly = svgEl('polygon', { class: `wvw-sector own-${owner}`, points });
    const t = svgEl('title', {});
    t.textContent = sec.name || '';
    poly.appendChild(t);
    fills.appendChild(poly);
    unders.appendChild(svgEl('polygon', { points }));
    const edge = svgEl('polygon', { class: `own-${owner}`, points });
    overs.appendChild(edge);
    tinted.push({ id: sec.id, fill: poly, edge });
  }
  land.appendChild(fills);
  land.appendChild(unders);
  land.appendChild(overs);
  svg.appendChild(land);

  const markers = svgEl('g', {});
  pts.sort((a, b) => OBJ_DRAW_ORDER.indexOf(a.ob.type) - OBJ_DRAW_ORDER.indexOf(b.ob.type));
  const nodes = [];

  // Everything about a marker that can change while you are looking at it,
  // in one function, so a live update runs the same code as the first
  // draw. The listeners live on the group itself, so emptying it is safe,
  // and the selected class is carried across.
  // What each marker was last drawn from, so the 30 s refresh redraws only
  // the objectives that changed. Redrawing all of them rebuilt every icon,
  // shield and emblem - the emblem through an SVG filter - to paint the
  // same picture again. The tier and the waypoint are part of it, not just
  // the objective: they come from upgradeCatalogue, which usually lands
  // after the first drawing, and a key of the objective alone left those
  // markers without their shields for good.
  const drawnFrom = new WeakMap();
  const markerKey = (p) => {
    const tierInfo = objectiveTier(p.meta, p.ob);
    return JSON.stringify(p.ob) + '|' + (tierInfo ? tierInfo.tier : '-')
      + '|' + hasWaypoint(mapData.type, p.ob, tierInfo);
  };
  const paintMarker = (g, p) => {
    drawnFrom.set(g, markerKey(p));
    const r = OBJ_SIZE[p.ob.type] || 14;
    const owner = String(p.ob.owner || 'neutral').toLowerCase();
    const tierInfo = objectiveTier(p.meta, p.ob);
    const tier = tierInfo ? tierInfo.tier : 0;
    const selected = g.classList.contains('is-selected') ? ' is-selected' : '';
    g.setAttribute('class', `wvw-marker own-${owner} tier-${tier}${selected}`);
    while (g.firstChild) g.removeChild(g.firstChild);

    // The icon's own disc, and nothing past it. It used to reach half a
    // radius further, which swallowed the badges hanging off the marker:
    // both have to answer for themselves now, and where the RI badge
    // reached past even that, nothing answered at all.
    g.appendChild(svgEl('circle', { class: 'hit', r }));
    // The icon already carries the team colour, so nothing is drawn
    // under it - a disc behind would only show as a second ring.
    const markerSrc = markerIcon(p.ob.type, p.ob.owner);
    if (markerSrc) {
      const icon = svgEl('image', {
        class: 'pip', href: markerSrc,
        x: -r, y: -r, width: r * 2, height: r * 2,
      });
      icon.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', markerSrc);
      g.appendChild(icon);
    }
    const wp = hasWaypoint(mapData.type, p.ob, tierInfo);
    if (wp) g.appendChild(waypointBadge(r, p));
    if (p.ob.claimed_by) g.appendChild(claimBadge(r, p.ob.claimed_by, emblemFilter));
    // Last, so the shields sit over the claim badge instead of being
    // crossed by it.
    if (tier) g.appendChild(tierShields(r, tier));
    const ri = riBadge(r, p.ob);
    if (ri) g.appendChild(ri);
    const tip = svgEl('title', {});
    // The same words the detail panel uses. This said "Red" where a click
    // said "Mosswood", and "T3" where a click said "Fortified" - two
    // names for one thing, a hover apart. Nothing is lost by dropping the
    // colour: the marker under the cursor is painted it.
    const ownerId = COLORS.includes(owner) ? matchTeamId(match, owner) : null;
    const tierName = tierInfo && tierInfo.tier ? tierInfo.name : null;
    tip.textContent = `${p.meta.name || p.ob.id} · `
      + ((ownerId && getTeamName(ownerId)) || p.ob.owner)
      + (tierName ? ` · T${tierInfo.tier} ${tierName}` : '');
    g.appendChild(tip);
  };

  for (const p of pts) {
    const g = svgEl('g', {
      transform: `translate(${p.x} ${p.y})`,
      tabindex: '0',
      role: 'button',
    });
    paintMarker(g, p);

    const pick = (e) => {
      e.stopPropagation();
      for (const n of nodes) n.classList.remove('is-selected');
      g.classList.add('is-selected');
      onSelect(p, match);
    };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); }
    });
    markers.appendChild(g);
    nodes.push(g);
  }
  svg.appendChild(markers);
  wrap.appendChild(svg);

  // ---- zoom and pan -------------------------------------------------
  // The viewBox is the camera. Markers are pinned to the ground but
  // damped - see MARKER_FOLLOW - so zooming in grows them along with the
  // terrain instead of leaving them floating above it at a fixed size.
  const view = { x: minX, y: minY, w: fullW, h: fullH };

  // The full picture, once the terrain is drawn wider on screen than the
  // lite one has pixels. Decoded off to the side and laid over the lite
  // one, which only goes once the new node has loaded and a frame has
  // shown both - swapping the href instead leaves the ground blank while
  // the file decodes. The node asks for the file again (a revalidation,
  // assets are max-age=0), hence waiting on its own load. Width comes
  // from a ResizeObserver, so a zoom never has to ask for layout.
  let shownWidth = 0;
  let upgrading = false;
  const upgradeTerrain = () => {
    if (!terrain || upgrading) return;
    const onScreen = shownWidth * (window.devicePixelRatio || 1) * (picture.w / view.w);
    if (onScreen <= LITE_WIDTH) return;
    upgrading = true;
    const full = new Image();
    full.src = picture.src;
    const lite = terrain;
    const swap = () => {
      const next = terrainAt(picture.src);
      next.addEventListener('load', () => {
        terrain = next;
        requestAnimationFrame(() => requestAnimationFrame(() => lite.remove()));
      }, { once: true });
      next.addEventListener('error', () => next.remove(), { once: true });
      svg.insertBefore(next, lite.nextSibling);
    };
    // A full picture that fails leaves the lite one where it is.
    if (full.decode) full.decode().then(swap, () => {});
    else full.onload = swap;
  };
  if (terrain && window.ResizeObserver) {
    new ResizeObserver((entries) => {
      shownWidth = entries[entries.length - 1].contentRect.width;
      upgradeTerrain();
    }).observe(svg);
  }

  const apply = () => {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const k = Math.pow(view.w / fullW, MARKER_FOLLOW);
    for (let i = 0; i < nodes.length; i++) {
      const p = pts[i];
      nodes[i].setAttribute('transform', `translate(${p.x} ${p.y}) scale(${k})`);
    }
  };

  const clamp = () => {
    view.w = Math.min(fullW, Math.max(fullW / MAX_ZOOM, view.w));
    view.h = view.w * (fullH / fullW);
    view.x = Math.min(minX + fullW - view.w, Math.max(minX, view.x));
    view.y = Math.min(minY + fullH - view.h, Math.max(minY, view.y));
  };

  const zoomBy = (factor, cx, cy) => {
    const before = view.w;
    view.w = before * factor;
    clamp();
    // Keep the point under the cursor where it was.
    const scale = view.w / before;
    view.x = cx - (cx - view.x) * scale;
    view.y = cy - (cy - view.y) * scale;
    clamp();
    apply();
    upgradeTerrain();
  };

  const atEvent = (e) => {
    const r = svg.getBoundingClientRect();
    return {
      x: view.x + ((e.clientX - r.left) / r.width) * view.w,
      y: view.y + ((e.clientY - r.top) / r.height) * view.h,
    };
  };

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const at = atEvent(e);
    zoomBy(e.deltaY > 0 ? 1.18 : 1 / 1.18, at.x, at.y);
  }, { passive: false });

  let dragging = null;
  wrap.addEventListener('pointerdown', (e) => {
    // The zoom controls live inside the map, and starting a drag here
    // calls setPointerCapture on the wrapper - which retargets the
    // click to the wrapper and means the button's own click listener
    // never runs. That is why the buttons did nothing.
    if (e.target.closest('.wvw-marker, .wvw-zoom, .wvw-hud, .wvw-hud-note')) return;
    dragging = { at: atEvent(e), x: view.x, y: view.y };
    wrap.classList.add('is-panning');
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width) * view.w;
    const dy = ((e.clientY - r.top) / r.height) * view.h;
    // Keep the point grabbed at pointerdown under the cursor. This read
    // the live view.x, which it had just moved itself, so every frame
    // after the first was measured against the wrong origin and the map
    // crept away from the pointer.
    view.x = dragging.at.x - dx;
    view.y = dragging.at.y - dy;
    clamp();
    apply();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = null;
    wrap.classList.remove('is-panning');
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  const zoomBox = document.createElement('div');
  zoomBox.className = 'wvw-zoom';
  for (const [label, factor] of [['+', 1 / 1.35], ['\u2212', 1.35]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', factor < 1 ? 'Zoom in' : 'Zoom out');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      zoomBy(factor, view.x + view.w / 2, view.y + view.h / 2);
    });
    zoomBox.appendChild(b);
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = '\u2302';
  // Not "reset the view": in this mode reset is Friday night, and the
  // message a few lines down uses the word in exactly that sense.
  reset.setAttribute('aria-label', 'Recentre the map');
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    view.x = minX; view.y = minY; view.w = fullW; view.h = fullH;
    apply();
  });
  zoomBox.appendChild(reset);
  wrap.appendChild(zoomBox);

  // Says which half is missing. The map is drawn and readable either
  // way, so this is not an error state - it is the colours being late.
  const waiting = document.createElement('p');
  waiting.className = 'wvw-waiting';
  waiting.textContent = "Just after reset — ArenaNet hasn't published this map yet";
  waiting.hidden = owners.size > 0;
  wrap.appendChild(waiting);

  // Repaint from fresher objective data without rebuilding anything.
  // Nothing about the drawing moves - same nodes, same viewBox - so the
  // zoom you set and the objective you had selected both survive, which
  // is the whole point of doing it this way instead of re-rendering.
  wrap.applyLive = (freshMapData, isLive) => {
    owners = ownersOf(freshMapData, isLive);
    for (let i = 0; i < pts.length; i++) {
      // Back to Neutral when an owner goes away, rather than keeping the
      // last one seen: the API has handed back a blank list mid-relink,
      // and holding on to what was there would leave a map claiming an
      // ownership nobody is asserting any more.
      pts[i].ob = owners.get(pts[i].meta.id) || blank(pts[i].meta);
      if (drawnFrom.get(nodes[i]) !== markerKey(pts[i])) paintMarker(nodes[i], pts[i]);
    }
    waiting.hidden = owners.size > 0;
    const ownerNow = new Map();
    for (const p of pts) {
      if (p.meta.sector_id) ownerNow.set(p.meta.sector_id, p.ob.owner);
    }
    for (const t of tinted) {
      const owner = String(ownerNow.get(t.id) || 'neutral').toLowerCase();
      if (t.edge.getAttribute('class') === `own-${owner}`) continue;
      t.fill.setAttribute('class', `wvw-sector own-${owner}`);
      t.edge.setAttribute('class', `own-${owner}`);
    }
    apply();   // repainted markers lost their zoom scale
  };

  return wrap;
}


// ---- the score bar --------------------------------------------------
// One segment per side, as wide as that side's share of THIS map's tick.
// Per map, not the match total: whoever is running the map fills the bar,
// and a side that has stopped scoring shrinks out of it. A match-wide
// number would be identical on all four tabs.
function buildScoreBar(mapData, isLive) {
  const { by } = mapTally(mapData, isLive);
  const vals = COLORS.map((c) => Math.max(0, Number((by.get(c) || {}).ppt || 0)));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return null;

  const bar = document.createElement('div');
  bar.className = 'wvw-scorebar';
  COLORS.forEach((c, i) => {
    // A side on zero is not drawn at all. Giving it a zero-width span
    // would still leave its 2px separator hanging in empty bar.
    if (!vals[i]) return;
    const seg = document.createElement('span');
    seg.className = `wvw-scorebar-seg own-${c}`;
    // Percentages rather than flex-grow: flex would hand a share back to
    // a side that has none.
    seg.style.width = `${(vals[i] / total) * 100}%`;
    bar.appendChild(seg);
  });
  return bar.childElementCount ? bar : null;
}

// ---- the map scoreboard ---------------------------------------------
// The four types that pay. Ruins and Mercenary tick zero, which is also
// why the game's own Contested Areas panel shows four icons and not six.
// Smallest first, the order that panel uses.
const SCORE_TYPES = ['Camp', 'Tower', 'Keep', 'Castle'];

// What each side holds across whatever maps it is handed: the tick they
// add up to, and how many of each structure. All of it comes out of the
// objective lists the standings fetch already paid for, so it costs no
// request at all.
function tallyMaps(maps, isLive) {
  const by = new Map();
  for (const c of COLORS) by.set(c, { ppt: 0, counts: new Map() });
  // Which of the four are in play at all. Across the whole match that is
  // always the four; over a single borderland it drops the castle, which
  // would otherwise be a column of zeroes using up width to say nothing.
  const present = new Set();
  if (!isLive) return { by, types: [] };
  for (const m of maps || []) {
    for (const ob of (m && m.objectives) || []) {
      if (SCORE_TYPES.includes(ob.type)) present.add(ob.type);
      const row = by.get(String(ob.owner || '').toLowerCase());
      if (!row) continue;
      row.ppt += Number(ob.points_tick || 0);
      if (SCORE_TYPES.includes(ob.type)) {
        row.counts.set(ob.type, (row.counts.get(ob.type) || 0) + 1);
      }
    }
  }
  return { by, types: SCORE_TYPES.filter((t) => present.has(t)) };
}

function mapTally(mapData, isLive) {
  return tallyMaps(mapData ? [mapData] : [], isLive);
}

// One row per side, the leader on top, totalled over the whole match -
// what the game's own Contested Areas panel shows, and what leaves this
// and the bar over the map answering different questions: the bar is
// this map, the board is the war. Sorting by tick means rows can swap
// places on the 30s refresh, which is why each carries the team colour
// as well as the name.
function paintMapBoard(board, match, isLive) {
  board.textContent = '';
  const { by, types } = tallyMaps(match && match.maps, isLive);
  const rows = COLORS.map((c) => ({ color: c, ...by.get(c) }));
  if (!isLive || !rows.some((r) => r.ppt || r.counts.size)) {
    board.hidden = true;
    return;
  }
  board.hidden = false;
  // Ties keep the fixed colour order, so a 0-0 map does not shuffle on
  // every refresh for no reason.
  rows.sort((a, b) => (b.ppt - a.ppt) || (COLORS.indexOf(a.color) - COLORS.indexOf(b.color)));

  // The grid is set here rather than in the stylesheet because the
  // column count is the map's, not the design's. el.style goes through
  // the CSSOM, which the page's CSP does not govern.
  const grid = `repeat(${types.length}, var(--board-cell))`;

  // The header the game's panel has too, with the column names filled
  // in: the icons are the game's, but nobody has to already know them.
  const head = document.createElement('div');
  head.className = 'wvw-board-row wvw-board-head';
  const headLabel = document.createElement('span');
  headLabel.className = 'wvw-board-team';
  headLabel.textContent = 'Objectives held';
  head.appendChild(headLabel);
  const headCells = document.createElement('span');
  headCells.className = 'wvw-board-counts';
  headCells.style.gridTemplateColumns = grid;
  for (const type of types) {
    const h = document.createElement('span');
    h.textContent = type;
    headCells.appendChild(h);
  }
  head.appendChild(headCells);
  const headPpt = document.createElement('span');
  headPpt.className = 'wvw-board-ppt';
  headPpt.textContent = 'PPT';
  // Every map added up, not this one. The board has been match-wide
  // since it moved to the side column, and the bar over the map is the
  // per-map reading - saying "this map" here put the two in open
  // disagreement, a few centimetres apart.
  headPpt.title = 'Points per tick, every map added up';
  head.appendChild(headPpt);
  board.appendChild(head);

  for (const r of rows) {
    const line = document.createElement('div');
    line.className = `wvw-board-row own-${r.color}`;

    const name = document.createElement('span');
    name.className = 'wvw-board-team';
    const teamId = matchTeamId(match, r.color);
    name.textContent = teamId ? getTeamName(teamId) : r.color;
    name.title = name.textContent;
    line.appendChild(name);

    const counts = document.createElement('span');
    counts.className = 'wvw-board-counts';
    counts.style.gridTemplateColumns = grid;
    for (const type of types) {
      const n = r.counts.get(type) || 0;
      const cell = document.createElement('span');
      // Zero still gets its cell: the columns have to line up across
      // the three rows, and a side holding no keep at all is itself
      // worth seeing. Faded almost out, the way the game does it.
      cell.className = n ? 'wvw-board-cell' : 'wvw-board-cell is-none';
      const src = markerIcon(type, r.color);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.width = 22;
        img.height = 22;
        cell.appendChild(img);
      }
      // Beside the icon, not under it. Stacking is what the game does,
      // but the game has a full window for it; here three stacked rows
      // pushed the popover into a scrollbar, and the second line was
      // pure height - the number is the same number either way.
      const n_ = document.createElement('b');
      n_.textContent = String(n);
      cell.appendChild(n_);
      cell.title = `${n} ${type}${n === 1 ? '' : 's'}`;
      counts.appendChild(cell);
    }
    line.appendChild(counts);

    const ppt = document.createElement('span');
    ppt.className = 'wvw-board-ppt';
    ppt.textContent = `+${r.ppt}`;
    ppt.title = `${getTeamName(matchTeamId(match, r.color)) || r.color}`
      + ` earns ${r.ppt} points per tick, every map added up`;
    line.appendChild(ppt);

    board.appendChild(line);
  }
}

// ---- the detail panel ------------------------------------------------
// How far along the next tier is, in the game's own x/y shape with a bar
// under it. The bar fills to the same fraction the numbers state, so the
// two can never disagree - what it is NOT is progress within the current
// tier. At the top it says "max" and drops the bar but keeps the icon:
// 100/100 under a full bar reads as progress towards something that is
// not there.
function yakCell(t) {
  const cell = document.createElement('span');
  cell.className = 'wvw-yakcell';

  // The game's own caravan icon, so the pair of numbers says what it is
  // counting without spending a word on it in a column this narrow.
  const line = document.createElement('span');
  line.className = 'wvw-yaknum';
  const icon = document.createElement('img');
  icon.src = 'assets/icons/Event_Caravan.webp';
  // At the top tier the row label already says "Yaks", so the icon is
  // decoration and repeating the word just reads it twice. On the way
  // up the label names the tier instead, and then the icon is the only
  // thing saying what is being counted.
  icon.alt = t.next ? 'yaks' : '';
  icon.width = 15;
  icon.height = 15;
  line.appendChild(icon);
  const n = document.createElement('b');
  n.textContent = t.next ? `${t.yaks}/${t.next.at}` : `${t.yaks} — max`;
  line.appendChild(n);
  cell.appendChild(line);

  // No bar at the top tier. A full bar is a progress reading, and there
  // is no progress left to report - the word says it in less space and
  // without pretending something is still being counted towards.
  if (t.next) {
    const track = document.createElement('span');
    track.className = 'wvw-yakbar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, (t.yaks / t.next.at) * 100)}%`;
    track.appendChild(fill);
    cell.appendChild(track);
  }

  const left = t.next ? Math.max(0, t.next.at - t.yaks) : 0;
  cell.title = t.next
    ? `${left} more dolyak${left === 1 ? '' : 's'} to ${t.next.name}`
      + ' — and the count resets to zero if it flips'
    : `Fully upgraded on ${t.yaks} dolyaks — the count resets to zero`
      + ' if it flips';
  return cell;
}

function row(dl, label, value, cls) {
  const wrap = document.createElement('div');
  wrap.className = 'wvw-row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (cls) dd.className = cls;
  if (value instanceof Node) dd.appendChild(value); else dd.textContent = value;
  wrap.appendChild(dt);
  wrap.appendChild(dd);
  dl.appendChild(wrap);
}

// Breaks the list into the three questions it actually answers: whose it
// is, what it pays, how upgraded it is. Same styling as the tactics
// heading further down, so this is grouping, not a new look.
function group(dl, label) {
  const h = document.createElement('div');
  h.className = 'wvw-group';
  h.textContent = label;
  dl.appendChild(h);
}

function renderObjectiveDetail(panel, p, match) {
  panel.textContent = '';
  const { ob, meta } = p;
  // Which objective this panel is currently showing, so a fetch that
  // lands late cannot repaint over a different one.
  panel.dataset.showing = String(ob.id);

  const name = document.createElement('div');
  name.className = 'wvw-detail-name';
  // The same shields the map draws, in the same tier colour, rather than
  // a number in a bronze lozenge that matched nothing. Whatever you
  // learned to read on the map reads here too.
  const tierInfo = objectiveTier(meta, ob);
  if (tierInfo && tierInfo.tier > 0) {
    const chip = document.createElement('span');
    chip.className = `wvw-tierchip tierchip-${tierInfo.tier}`;
    // The same form the row below and the marker tooltip use. The number
    // stays: "T3" is how the mode is spoken, and dropping it for the
    // game's name alone would have been less familiar, not more.
    chip.title = `T${tierInfo.tier} ${tierInfo.name}`;
    for (let i = 0; i < tierInfo.tier; i++) chip.appendChild(document.createElement('i'));
    name.appendChild(chip);
  }
  name.appendChild(document.createTextNode(meta.name || ob.id));
  panel.appendChild(name);

  const ownerColor = String(ob.owner || '').toLowerCase();
  const owned = COLORS.includes(ownerColor);
  const ownCls = owned ? `wvw-owner own-${ownerColor}` : null;

  // The type carries the very marker the map draws for it, already in
  // the holder's colour: one glance says what it is and whose it is.
  const type = document.createElement('div');
  type.className = 'wvw-detail-type';
  const tsrc = markerIcon(ob.type, ownerColor);
  if (tsrc) {
    const timg = document.createElement('img');
    timg.src = tsrc;
    timg.alt = '';
    timg.width = 18;
    timg.height = 18;
    type.appendChild(timg);
  }
  type.appendChild(document.createTextNode(ob.type));
  panel.appendChild(type);

  const dl = document.createElement('dl');
  const teamId = owned ? matchTeamId(match, ownerColor) : null;

  group(dl, 'Held by');
  row(dl, 'Team', teamId ? getTeamName(teamId) : (ob.owner || 'Nobody'), ownCls);
  const ago = flippedAgo(ob.last_flipped);
  if (ago) row(dl, 'For', ago);
  const claimCell = document.createElement('span');
  if (ob.claimed_by) {
    claimCell.className = 'wvw-claimed';
    claimCell.textContent = 'loading…';
    // Straight through the same cache the guild checker uses, so a guild
    // that holds three objectives is still only looked up once.
    guildEmblem(ob.claimed_by).then(({ info, layers }) => {
      claimCell.textContent = '';
      if (layers.length) {
        // An SVG rather than an img, because the layers have to be tinted
        // and stacked - the same drawing the marker gets, at a fifth of
        // the size. Its own defs and its own ids, since it lives outside
        // the map's SVG entirely.
        const svg = svgEl('svg', { class: 'wvw-emblem', viewBox: '0 0 1 1' });
        const defs = svgEl('defs', {});
        svg.appendChild(defs);
        paintEmblem(svg, layers, { x: 0, y: 0, w: 1, h: 1 },
          emblemFilterFactory(defs, `wvw-panel-emblem-${++plotSerial}`));
        claimCell.appendChild(svg);
      }
      claimCell.appendChild(document.createTextNode(`[${info.tag}] ${info.name}`));
    }).catch(() => { claimCell.textContent = 'claimed, name unavailable'; });
  } else {
    claimCell.textContent = 'unclaimed';
  }
  row(dl, 'Guild', claimCell);

  group(dl, 'Worth');
  row(dl, 'Per tick', `+${ob.points_tick ?? 0}`, ownCls);
  row(dl, 'On capture', String(ob.points_capture ?? 0));

  group(dl, 'Upgrade');
  // The game's own names for the tiers, straight out of the API. "Tier 2"
  // meant nothing to anyone who did not already know the ladder.
  if (tierInfo) {
    // "of 3" is gone because every objective in the mode has exactly
    // three tiers, so it never told anyone anything. Not "paper"
    // either: that word covers T1 as well, so it is not a synonym for
    // this.
    row(dl, 'Now', tierInfo.tier ? `T${tierInfo.tier} ${tierInfo.name}` : 'Not upgraded');
  }
  if (tierInfo && tierInfo.next) {
    row(dl, `To ${tierInfo.next.name}`, yakCell(tierInfo));
  } else if (tierInfo) {
    row(dl, 'Yaks', yakCell(tierInfo));
  } else {
    row(dl, 'Yaks delivered', String(ob.yaks_delivered ?? 0));
  }

  panel.appendChild(dl);

  // Tactics, not the automatic tier upgrades - those follow from the yak
  // count and are already summed up above. What is worth listing is what
  // the holding guild chose to install.
  //
  // One field carries two different things. An improvement is bought once
  // and is simply on from then; a tactic sits in a slot waiting for
  // supply and for someone to press it, and only that is something an
  // attack has to time around - so they get a heading each, tactics
  // first, the way the game splits them. The API types both as
  // "Claimable" and tells them apart only through the item each one
  // costs, whose name ends in "Tactic" or "Improvement": ten and eleven
  // across the catalogue, no exceptions. Anything matching neither is
  // listed with the tactics, so a new kind of upgrade shows up instead of
  // being quietly swallowed.
  const isImprovement = (t) => {
    const cost = t && (t.costs || [])[0];
    return !!cost && /\bImprovement$/i.test(cost.name || '');
  };
  const installed = Array.isArray(ob.guild_upgrades) ? ob.guild_upgrades : [];

  // The catalogue is fetched once for the whole match when the popover
  // opens, so anything installed after that came out as a bare
  // "Upgrade 379" at exactly the moment the name was worth having.
  // Fetched on sight instead, and the panel repaints when it lands. The
  // second check is the brake: a repaint that changes nothing would ask
  // again for ever.
  const unknown = installed.filter((id) => !(tacticCatalogue && tacticCatalogue.has(id)));
  if (unknown.length) {
    getTacticCatalogue(unknown).then(() => {
      if (panel.dataset.showing !== String(ob.id)) return;
      if (!unknown.some((id) => tacticCatalogue.has(id))) return;
      renderObjectiveDetail(panel, p, match);
    });
  }

  const tactics = [];
  const improvements = [];
  for (const id of installed) {
    const t = tacticCatalogue && tacticCatalogue.get(id);
    (isImprovement(t) ? improvements : tactics).push(id);
  }

  // Both lists go in one container so they can sit side by side; the
  // stylesheet decides whether there is room for that.
  const cols = document.createElement('div');
  cols.className = 'wvw-upgrade-cols';

  const listUpgrades = (label, ids) => {
    if (!ids.length) return;
    const group = document.createElement('div');
    const heading = document.createElement('div');
    heading.className = 'wvw-upgrade-tier';
    heading.textContent = `${label} (${ids.length})`;
    group.appendChild(heading);
    const ul = document.createElement('ul');
    ul.className = 'wvw-upgrades';
    for (const id of ids) {
      const t = tacticCatalogue && tacticCatalogue.get(id);
      const li = document.createElement('li');
      const src = upgradeIcon(t && t.icon);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      }
      li.appendChild(document.createTextNode(t ? t.name : `Upgrade ${id}`));
      if (t && t.description) li.title = t.description;
      ul.appendChild(li);
    }
    group.appendChild(ul);
    cols.appendChild(group);
  };
  // Tactics first, so the column that collapses to the top row on a
  // narrow screen is the one you read before deciding to hit a place. The
  // game's own claiming panel puts improvements first, but that is a
  // panel for running an objective you hold; this one is for sizing up
  // someone else's.
  listUpgrades('Tactics', tactics);
  listUpgrades('Improvements', improvements);
  if (cols.childElementCount) panel.appendChild(cols);
}

// ---- the popover -----------------------------------------------------
function renderTierMapsContent(popover, match, regionName, tierNum, catalogue,
                               sectorsByType, pendingSectors, triggerEl) {
  popover.textContent = '';

  const header = document.createElement('div');
  header.className = 'info-popover-header';
  const title = document.createElement('span');
  title.textContent = `${regionName} Tier ${tierNum} · Live map`;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'info-popover-header-actions';
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'info-popover-expand';
  expandBtn.innerHTML = EXPAND_ICON_COLLAPSE;
  expandBtn.setAttribute('aria-label', 'Shrink back to normal size');
  expandBtn.title = expandBtn.getAttribute('aria-label');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPopoverExpanded(popover, triggerEl,
      !popover.classList.contains('info-popover--expanded'));
  });
  actions.appendChild(expandBtn);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-popover-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closePopover);
  actions.appendChild(closeBtn);
  header.appendChild(actions);
  popover.appendChild(header);

  const byType = new Map((match.maps || []).map((m) => [m.type, m]));
  // A tab exists because the tier has that map, not because its outline
  // has arrived yet - the outlines for the three tabs you did not open
  // are still in flight when this runs.
  const available = MAP_PANEL_ORDER.filter((t) => byType.has(t) && pendingSectors.has(t));
  if (!available.length) {
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = 'No objective data for this tier right now.';
    popover.appendChild(msg);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'wvw-tabs';
  popover.appendChild(tabs);

  const stage = document.createElement('div');
  stage.className = 'wvw-stage';
  popover.appendChild(stage);

  // The right-hand column: the scoreboard on top, the objective detail
  // under it. Both answer "who holds what", so they read as one column,
  // and neither is ever over the map.
  const side = document.createElement('div');
  side.className = 'wvw-side';

  const board = document.createElement('div');
  board.className = 'wvw-board';
  board.hidden = true;
  side.appendChild(board);

  const detail = document.createElement('div');
  detail.className = 'wvw-detail';
  side.appendChild(detail);

  // What the detail panel is showing, so the refresh can repaint it.
  // Cleared with the panel, because a point belongs to the stage that
  // drew it and switching tabs throws that stage away.
  let selected = null;

  const emptyDetail = () => {
    selected = null;
    detail.textContent = '';
    const p = document.createElement('p');
    p.className = 'wvw-detail-empty';
    // "upgraded with" was wrong: the tier is bought by yaks and arrives
    // on its own, and the lists under it are what the holding guild
    // chose to install. Both are named because the game names them
    // apart, and a defender treats them apart.
    p.textContent = 'Click an objective to see who holds it, how long they have had it, and its tactics and improvements.';
    detail.appendChild(p);
  };

  let current = null;
  let plotWrap = null;
  // The corners' state, and what they last read: killView's answer that
  // picked the hot tab (null before the first).
  let corners = null;
  let hotView = null;
  let hotType = null; // the tab markHotTab chose, null when none is hot
  // Until this popover's own first read ends, the score time is the
  // standings' read (up to five minutes old) and could flash amber: an age
  // that is not stale yet shows at once, a stale one waits for the read.
  let firstReadDone = false;
  const paintCorners = () => {
    if (!corners) return;
    const rose = matchScoreRoseAt(match.id);
    const known = firstReadDone || (rose > 0 && Date.now() - rose <= HUD_STALE_MS);
    corners.paint(hotView, current, known ? rose : 0);
    // Orange swords only on the busiest map; elsewhere they are neutral.
    const l = plotWrap && plotWrap.querySelector('.wvw-hud-l');
    if (l) l.classList.toggle('is-cold', current !== hotType);
  };

  const draw = (type, sectors) => {
    paintMapBoard(board, match, matchIsLive(match));
    stage.textContent = '';
    plotWrap = sectors && sectors.length
      ? buildMapStage(match, byType.get(type), sectors, catalogue,
        (p, m) => { selected = p; renderObjectiveDetail(detail, p, m); })
      : null;
    if (plotWrap) {
      // Over the plot, not inside the SVG: the SVG is the camera and
      // everything in it pans and zooms with the terrain.
      const sb = buildScoreBar(byType.get(type), matchIsLive(match));
      if (sb) plotWrap.appendChild(sb);
      corners = buildMapCorners(plotWrap);
      paintCorners();
      stage.appendChild(plotWrap);
    } else {
      // The outline is what the drawing gets its frame from, so without
      // it there is no map to show - but the other tabs are unaffected,
      // which is why this replaces the stage and not the popover.
      const msg = document.createElement('p');
      msg.className = 'hint wvw-stage-msg';
      msg.textContent = "Couldn't load this map right now.";
      stage.appendChild(msg);
    }
    stage.appendChild(side);
    emptyDetail();
  };

  const show = (type) => {
    if (current === type) return;
    current = type;
    for (const b of tabs.children) b.classList.toggle('is-active', b.dataset.type === type);
    const ready = sectorsByType.get(type);
    if (ready) { draw(type, ready); return; }
    // Not here yet. Only the tab that opens is waited on before the
    // popover is built, so clicking one of the others early can land
    // ahead of its outline.
    stage.textContent = '';
    const wait = document.createElement('p');
    wait.className = 'hint wvw-stage-msg';
    wait.innerHTML = '<span class="spinner"></span>Loading this map\u2026';
    stage.appendChild(wait);
    pendingSectors.get(type).then((arr) => {
      // Both checks matter: the popover can be closed and another tab
      // can be picked while this is in the air.
      if (activeTrigger !== triggerEl || current !== type) return;
      if (arr && arr.length) sectorsByType.set(type, arr);
      draw(type, arr);
    });
  };

  const tabByType = new Map();

  let hotMarked = false;
  const markHotTab = (src) => {
    const { hot, rates, view } = hotMapOf(newestBodyOf(src), available);
    hotMarked = true;
    hotView = view;
    hotType = hot;
    paintCorners();
    paintMapBadges(match.id);

    for (const [type, b] of tabByType) {
      const had = b.querySelector('.wvw-tab-swords');
      if (type === hot) {
        if (!had) {
          const im = document.createElement('img');
          im.className = 'wvw-tab-swords';
          im.src = 'assets/icons/Event_Swords.webp';
          im.alt = '';
          im.width = 14;
          im.height = 14;
          b.insertBefore(im, b.firstChild);
          // The label shifts over rather than the swords sitting in the
          // text flow: pinned to the corner they would land on top of it.
          b.classList.add('is-hot');
        }
        const c = fightCount(rates, type);
        b.title = `${MAP_PANEL_NAME[type] || type} —`
          + ` ${c.kills} kills in ${c.mins} min, more than any other map`;
      } else {
        if (had) { had.remove(); b.classList.remove('is-hot'); }
        b.title = MAP_PANEL_NAME[type] || type;
      }
    }
  };

  // The freshest answer this popover has seen, which is not the one it
  // opened with. Everything that reads "how the match stands right now"
  // has to read this, or it quietly undoes the opening pull - which is
  // exactly what the kill sheet's callback used to do.
  let liveMatch = match;
  let hotFresh = false;

  // One fetch of this tier's match, and everything that has to be
  // repainted when it lands. Called on opening and then on the poll.
  // Stamped when asked, not when answered, so a catch-up and the poll do
  // not both fire for the same gap. The sequence number keeps a slow
  // answer from painting over a newer one that overtook it.
  let pulledAt = 0;
  let pullSeq = 0;
  const pullFresh = async () => {
    pulledAt = Date.now();
    const asked = Date.now();
    const seq = ++pullSeq;
    let fresh;
    try {
      // Never behind what this page has already seen: see fetchMatches.
      fresh = await fetchMatches(`${API_BASE}/wvw/matches?id=${encodeURIComponent(match.id)}`);
    } catch { firstReadDone = true; return; }
    firstReadDone = true;
    if (seq !== pullSeq) return;
    if (activeTrigger !== triggerEl || !fresh || !Array.isArray(fresh.maps)) return;
    for (const m of fresh.maps) if (byType.has(m.type)) byType.set(m.type, m);
    liveMatch = fresh;
    // Outlives the popover, so reopening starts from here.
    if (freshRecall) freshRecall.data = fresh;
    hotFresh = true;
    recordFightSamples([fresh], asked);
    markHotTab(liveMatch);
    const now = byType.get(current);
    // Asked of the answer that just arrived, not of the match this
    // popover opened with: a tier turns over while the maps are open,
    // and it has also been seen turning back.
    const live = matchIsLive(fresh);
    paintMapBoard(board, fresh, live);
    if (plotWrap && plotWrap.applyLive && now) plotWrap.applyLive(now, live);
    // The panel was born from a click and then stood still: the marker
    // beside it could change hands, tier or guild while the text went
    // on describing the moment it was clicked. applyLive rewrites the
    // point in place, so repainting is all it takes.
    if (selected) renderObjectiveDetail(detail, selected, fresh);
    if (plotWrap) {
      const old = plotWrap.querySelector('.wvw-scorebar');
      const sb = buildScoreBar(now, live);
      if (old) old.remove();
      if (sb) plotWrap.appendChild(sb);
    }
    paintCorners();
  };

  // The maps keep themselves current while they are open. The standings
  // refresh cannot do it for them: it rebuilds the whole board, and the
  // button this popover is anchored to goes with it. So this asks for one
  // match, not all nine, and repaints in place.
  //
  // Visible is enough, focus is not asked for: the window beside the game,
  // unfocused on a second monitor, is where these maps are read. Gated on
  // focus, they froze for as long as the game had it. Only a hidden tab
  // skips the tick, and mapCatchUp pulls the moment it is shown again.
  clearInterval(mapPollTimer);
  mapPollTimer = setInterval(() => {
    if (activeTrigger !== triggerEl) { clearInterval(mapPollTimer); return; }
    if (document.visibilityState === 'hidden') return;
    // A catch-up just ran; this tick would ask again seconds later.
    if (Date.now() - pulledAt < MAP_REFRESH_MS / 2) return;
    pullFresh();
  }, MAP_REFRESH_MS);
  mapCatchUp = () => {
    if (activeTrigger !== triggerEl) return;
    if (Date.now() - pulledAt >= MAP_REFRESH_MS) pullFresh();
  };

  clearInterval(mapTickTimer);
  mapTickTimer = setInterval(() => {
    if (activeTrigger !== triggerEl) { clearInterval(mapTickTimer); return; }
    tickRi(stage);
    // The kills' silence grows by the second as the score's age does: the
    // swords, the badge and the corner are judged again together.
    if (hotMarked) markHotTab(liveMatch); else paintCorners();
  }, 1000);

  for (const type of available) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wvw-tab';
    b.dataset.type = type;
    const label = document.createElement('span');
    label.textContent = MAP_TAB_NAME[type] || type;
    b.appendChild(label);
    b.title = MAP_PANEL_NAME[type] || type;
    b.addEventListener('click', (e) => { e.stopPropagation(); show(type); });
    tabs.appendChild(b);
    tabByType.set(type, b);
  }
  // The swords wait for the fresh reading rather than being painted from
  // the one this popover opened with. That reading can be five minutes
  // old, and measured against the kill sheet's own two hours it picks a
  // different map 38% of the time - so painting straight away put the
  // swords on the wrong tab in better than one opening in three and moved
  // them a breath later, which reads as a glitch. The tab titles are
  // already set above, so nothing is blank; the swords arrive about a
  // third of a second in. A fetch that never lands keeps the stale
  // reading, which still beats no swords.
  // Unless the body this page keeps rose within HOT_NOW_MS: that one is as
  // fresh as the read, so the swords and the kills go up at once.
  const keptNow = newestMatches.get(match.id);
  if (keptNow && Date.now() - keptNow.at <= HOT_NOW_MS) {
    liveMatch = keptNow.match;
    markHotTab(liveMatch);
  }
  setTimeout(() => {
    if (activeTrigger === triggerEl && !hotFresh) markHotTab(liveMatch);
  }, 2500);
  // Again when the sheet lands - but only once there is a fresh reading
  // for it to be applied to. Resolves from cache on every later open,
  // which is why this used to fire straight back over the fresh answer.
  getKillSheet().then(() => {
    if (activeTrigger !== triggerEl) return;
    if (hotFresh) markHotTab(liveMatch);
    else paintCorners(); // the history may have backdated the score time
  });
  show(available[0]);

  // And once, right now, rather than waiting out the first poll.
  //
  // This popover opens with the match the standings panel is holding, and
  // that panel refreshes every five minutes - the same five minutes
  // Righteous Indignation lasts, so the staleness is the size of the
  // whole thing it is meant to show. Measured across every live map on
  // 26/09, with 56 objectives under RI: the average two-and-a-half minute
  // old snapshot was missing half of them, and a five-minute one all of
  // them. It costs one request, blocks nothing - the map is already up -
  // and it fixes the swords in the same move.
  pullFresh();

  // The other three terrain pictures, once the first map is up and being
  // looked at. A tab switch used to start its own download at the click:
  // a few hundred kilobytes plus the decode, all of it between the click
  // and anything appearing. The lite pictures only: the full ones wait
  // for a zoom that needs them. decode() rather
  // than just src, because the decode runs on the main thread and that is
  // the half that would be seen. One at a time, in tab order - all three
  // at once is a couple of megabytes racing the pictures the VISIBLE map
  // is still pulling.
  const warmTerrain = () => {
    const queue = available.filter((t) => t !== current);
    const next = () => {
      if (activeTrigger !== triggerEl) return;   // closed while waiting
      const type = queue.shift();
      if (!type) return;
      const pic = MAP_IMAGE[(byType.get(type) || {}).id];
      if (!pic) { next(); return; }
      const im = new Image();
      im.src = pic.lite;
      // A warm-up that fails is not an error: the tab that needs it
      // asks again, which is exactly what happens today. Either way the
      // queue moves on.
      if (im.decode) im.decode().then(next, next);
      else { im.onload = next; im.onerror = next; }
    };
    next();
  };
  // Not for a connection that has asked to be spared. This is megabytes
  // of maps nobody has said they want to see.
  const conn = navigator.connection;
  if (!conn || !(conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) {
    if (window.requestIdleCallback) requestIdleCallback(warmTerrain, { timeout: 4000 });
    else setTimeout(warmTerrain, 1500);
  }
}

async function toggleTierMaps(match, regionName, tierNum, triggerEl) {
  const popover = openPopover(triggerEl, `${regionName} Tier ${tierNum} maps`, (el) => {
    const loading = document.createElement('p');
    loading.className = 'hint';
    loading.style.margin = '0';
    loading.innerHTML = '<span class="spinner"></span>Loading maps…';
    el.appendChild(loading);
  }, 'info-popover--maps');
  if (!popover) return; // it was already open; openPopover just closed it

  // Four maps and a detail panel do not fit in an anchored popover, so
  // this one opens the way the guild list looks once expanded.
  setPopoverExpanded(popover, triggerEl, true);

  // Reopen with what we already know, not with what the standings panel
  // is holding. That panel refreshes every five minutes, so a reopen
  // would paint from a snapshot this popover had already bettered and
  // then correct itself a second later. The correction is right, but it
  // reads as a glitch, and camps flip often enough to show it.
  //
  // Which of the two is newer is decided by identity, not by clocks:
  // every standings refresh parses fresh JSON, so a match object we have
  // seen before means that panel has not refreshed and ours is the newer
  // one. A different object means it is ahead of us, and it wins.
  if (freshRecall && freshRecall.from === match) {
    if (freshRecall.data) match = freshRecall.data;
  } else {
    freshRecall = { from: match, data: null };
  }

  const wanted = (match.maps || []).filter((m) => MAP_PANEL_ORDER.includes(m.type));
  const firstType = MAP_PANEL_ORDER.find((t) => wanted.some((m) => m.type === t));
  const firstMap = wanted.find((m) => m.type === firstType);

  // The terrain picture, asked for here rather than by the <image> node.
  // That node is built after everything below has resolved, so the
  // download used to queue up behind a second of API. Same URL, so the
  // <image> finds it in the browser's cache instead of asking again.
  const firstPic = firstMap && MAP_IMAGE[firstMap.id];
  if (firstPic) { const pre = new Image(); pre.src = firstPic.lite; }

  // Started, never awaited. None of these draws a map - tiers only light
  // the rings, tactics only name the list in the detail panel, and the
  // foreground catalogue only matters once a claim emblem resolves. They
  // land while the map is already on screen.
  getUpgradeCatalogue();
  getEmblemPieces();
  // Started here and never awaited: the swords are the last thing on the
  // screen that matters and the first tab must not wait on a spreadsheet.
  getKillSheet();
  const tacticIds = [];
  for (const m of match.maps || []) {
    for (const ob of m.objectives || []) {
      if (Array.isArray(ob.guild_upgrades)) tacticIds.push(...ob.guild_upgrades);
    }
  }
  if (tacticIds.length) getTacticCatalogue(tacticIds);

  // All four outlines go out at once, but only the tab that opens is
  // waited on. Measured on one opening: two maps answered in about 220ms
  // and two in about 1220ms, with 2ms of browser queueing - so the slow
  // ones were the server thinking, and waiting for all four charged every
  // opening the worst of them. show() waits on one if you get there
  // first.
  const sectorsByType = new Map();
  const pendingSectors = new Map();
  for (const m of wanted) {
    const p = getSectors(m.id).catch(() => []);
    pendingSectors.set(m.type, p);
    p.then((arr) => { if (arr.length) sectorsByType.set(m.type, arr); });
  }

  let catalogue;
  try {
    const [cat] = await Promise.all([
      getObjectiveCatalogue(),
      firstType ? pendingSectors.get(firstType) : null,
    ]);
    catalogue = cat;
  } catch {
    if (activeTrigger !== triggerEl) return;
    popover.textContent = '';
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = "Couldn't load the map data right now.";
    popover.appendChild(msg);
    return;
  }

  if (activeTrigger !== triggerEl) return; // closed while loading
  renderTierMapsContent(popover, match, regionName, tierNum, catalogue,
    sectorsByType, pendingSectors, triggerEl);
}

// The matches the tier buttons were built for, so the badge can be painted
// again when the shared kill history lands. A WeakMap: the buttons are
// rebuilt with every standings refresh and the old ones are dropped.
const tierMapButtons = new WeakMap();
let mapBadgesAsked = false;

// The newest body the page holds for the match (keepNewestMatch). The badge
// and the open map's tabs both judge this one, or they part: the button's
// own body is up to five minutes older than the map's.
function newestBodyOf(match) {
  const kept = match && newestMatches.get(match.id);
  return kept ? kept.match : match;
}

function paintMapBadge(btn) {
  const info = tierMapButtons.get(btn);
  if (!info) return;
  const { regionName, tierNum } = info;
  const match = newestBodyOf(info.match);
  const types = MAP_PANEL_ORDER.filter((t) => (match.maps || []).some((m) => m.type === t));
  const { hot } = hotMapOf(match, types);
  const had = btn.querySelector('.tier-map-badge');
  const name = hot ? (MAP_TAB_NAME[hot] || hot) : '';
  btn.setAttribute('aria-label', `Show the live map for ${regionName} Tier ${tierNum}` + (name ? ` \u2014 busiest: ${name}` : ''));
  btn.title = `Live map \u00b7 ${regionName} Tier ${tierNum}` + (name ? ` \u00b7 busiest: ${name}` : '');
  btn.classList.toggle('has-badge', !!hot);
  if (!hot) { if (had) had.remove(); return; }
  if (had) return;
  const badge = document.createElement('span');
  badge.className = 'tier-map-badge';
  const im = document.createElement('img');
  im.src = 'assets/icons/Event_Swords.webp';
  im.alt = '';
  im.width = 11;
  im.height = 11;
  badge.appendChild(im);
  btn.appendChild(badge);
}

// Every tier button on the page, or only those of one match (a server card
// carries one too).
function paintMapBadges(matchId) {
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const info = tierMapButtons.get(btn);
    if (info && (!matchId || info.match.id === matchId)) paintMapBadge(btn);
  }
}

// Once, after the first standings: the badge needs the shared history,
// which is otherwise read only when a map opens. Cached and with its own
// fallback, so this is the one extra read of /api/kills. Then repainted
// every 30 s from what the page already holds - the rate's window moves
// and the data ages without a new reading - with no request of its own.
// Started here, so one timer however many times the table is rebuilt.
function primeMapBadges() {
  if (mapBadgesAsked) return;
  mapBadgesAsked = true;
  getKillSheet().then(() => {
    paintMapBadges();
    setInterval(() => paintMapBadges(), MAP_REFRESH_MS);
  });
}

function buildTierMapButton(match, regionName, tierNum) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn tier-map-btn';
  btn.setAttribute('aria-label', `Show the live map for ${regionName} Tier ${tierNum}`);
  btn.title = `Live map · ${regionName} Tier ${tierNum}`;
  markPopoverTrigger(btn);
  // The folded map. A miniature of the territory was tried and came out
  // worse - four coloured patches at this size read as a badge, not a
  // map. The dot does the same job as the zigzag: the zigzag says the
  // sheet is folded, the dot says something is drawn on it. Word first,
  // glyph after, matching the server cards.
  btn.innerHTML = '<span class="tier-map-label">Live maps</span>' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6.5 9 3l6 3.5 6-3.5v14.5l-6 3.5-6-3.5-6 3.5Z"/>' +
    '<path d="M9 3v14.5M15 6.5V21"/>' +
    '</g>' +
    '<circle cx="12" cy="9.2" r="1.6" fill="currentColor"/>' +
    '</svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTierMaps(match, regionName, tierNum, btn);
  });
  tierMapButtons.set(btn, { match, regionName, tierNum });
  paintMapBadge(btn);
  return btn;
}
