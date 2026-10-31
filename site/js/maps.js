'use strict';
// Tier maps: sector polygons, objective markers, tiers, claim emblems, tactics, pan and zoom.
// Ownership rides on the match object the standings fetch; positions come from the objective catalogue,
// and the polygons share the objectives' coordinate space. The terrain is a self-hosted wiki render
// (MAP_IMAGE, and the top of css/maps.css).
const MAP_PANEL_NAME = Object.freeze({
  Center: 'Eternal Battlegrounds',
  RedHome: 'Red Borderlands',
  BlueHome: 'Blue Borderlands',
  GreenHome: 'Green Borderlands',
});
// Spawns never change hands, so they are not drawn.
const MAP_SKIP_TYPES = new Set(['Spawn']);
// Drawn biggest first, so the smaller shape stays on top.
const OBJ_DRAW_ORDER = ['Castle', 'Keep', 'Tower', 'Mercenary', 'Camp', 'Ruins'];
// Marker radius in map units, also their on-screen size at the default view.
// Under half the closest pair of objectives (261 units), so no two overlap.
const OBJ_SIZE = Object.freeze({
  Castle: 118, Keep: 110, Tower: 100, Camp: 92, Mercenary: 92, Ruins: 80,
});
// How hard markers follow the zoom: 1 holds them fixed on screen, 0 pins them to the ground.
const MARKER_FOLLOW = 0.2;
// Markers that nearly follow the ground need a low ceiling or they grow huge.
const MAX_ZOOM = 4.5;

// Where each picture sits in continent coordinates (x, y, w, h).
// `edge` is our border width in map units; it has to cover the 5-unit white line printed into every render.
// EBG's render also has a 23-unit line in the home colour that 14 does not cover; it is removed from the
// image, so a fresh render needs it removed again.
// `lite` is the same picture LITE_WIDTH pixels wide; a map opens on it and takes `src` once the zoom
// needs more pixels than it holds (upgradeTerrain).
const LITE_WIDTH = 1280;
const MAP_IMAGE = Object.freeze({
  38: { src: 'assets/map-ebg.webp', lite: 'assets/map-ebg-1280.webp', x: 8846.4, y: 12710.9, w: 3308.0, h: 3293.5, edge: 14 },
  1099: { src: 'assets/map-rbl.webp', lite: 'assets/map-rbl-1280.webp', x: 9133.8, y: 8866.1, w: 3228.6, h: 3245.6, edge: 14 },
  96: { src: 'assets/map-bbl.webp', lite: 'assets/map-bbl-1280.webp', x: 12718.3, y: 10865.3, w: 2660.6, h: 3623.1, edge: 14 },
  95: { src: 'assets/map-gbl.webp', lite: 'assets/map-gbl-1280.webp', x: 5534.1, y: 11493.7, w: 2693.0, h: 3638.3, edge: 14 },
});

// The three EBG mercenary camps have no usable coord (label_coord sits off the camp), so these are read
// off the map render at 1.1638 pixels per map unit, good to about 3 units.
const MERC_COORD = Object.freeze({
  '38-123': [9972.9, 14197.7],    // Molevekian Delve
  '38-125': [11284.6, 14096.6],   // Orgath Uplands
  '38-126': [10692.6, 15310.5],   // Darkrait Inlet
});

// The game's own icons off the wiki, in assets/icons. Only Keep and Tower are published in all four
// colours; the rest are rebuilt by replaying on them the grey -> team change learned from those two.
// Shipped at 96px rather than the published 32, which a 143px marker at full zoom would stretch far further.
const MARKER_ICON = Object.freeze({
  Castle: 'Event_Castle', Keep: 'Event_Keep', Tower: 'Event_Tower',
  Camp: 'Event_Camp', Ruins: 'Event_Ruins',
  // The three EBG mercenary camps. The wiki has the crossed poleaxes only as a bare glyph, so the disc
  // is rebuilt from the camp icon with the axes knocked into it.
  Mercenary: 'Event_Mercenary',
});
let plotSerial = 0;
// mapPollTimer, mapTickTimer, mapCatchUp and mapAhead are declared in popover.js.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mapCatchUp) mapCatchUp();
});
window.addEventListener('focus', () => { if (mapCatchUp) mapCatchUp(); });
// The last answer a poll got, paired with the standings match it was pulled against: one slot, as only
// one tier's maps are open (fillTierMaps).
let freshRecall = null;

function markerIcon(type, owner) {
  const base = MARKER_ICON[type];
  if (!base) return null;
  const c = String(owner || '').toLowerCase();
  return `assets/icons/${base}${COLORS.includes(c) ? `_${c}` : ''}.webp`;
}

// Every upgrade a guild can install, copied in as well: serving every picture ourselves keeps img-src
// 'self'. An id that is not here draws nothing, so a new upgrade degrades to its name alone.
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

// The written-out copy, checked once; missing or malformed, everything falls back to the API.
function staticPack() {
  return (typeof WVW_STATIC === 'object' && WVW_STATIC) || null;
}

// Started once in the background. What comes back is what the NEXT opening uses; it never repaints
// under a cursor, so a map is never half from one catalogue and half from another.
function refreshCatalogueSoon() {
  fetchJsonCached(`${API_BASE}/wvw/objectives?ids=all`).then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    const byId = new Map();
    for (const o of list) byId.set(o.id, o);
    objectiveCatalogue = byId;
  }).catch(() => { /* the baked copy stands */ });
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

// Asks for every upgrade line, so it does not wait on the objective catalogue.
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

// The guild tactics installed on an objective, distinct from the upgrade tier (bought by yaks).
// Fetched for the whole match in one request.
async function getTacticCatalogue(ids) {
  if (!tacticCatalogue) tacticCatalogue = new Map();
  // Asked, not just answered: an id the API declines to return would be requested again on every repaint.
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

// A foreground id per guild, plus a catalogue of what each draws, as layered PNGs. Only the first layer
// is used, painted white. One request per session.
let emblemPieces = null;
let emblemPiecesPromise = null;

// Both halves of the catalogue (backdrop and device shapes), fetched together because an emblem needs both.
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
      // Dropped rather than remembered as an empty catalogue: kept, it would blank every claim emblem until
      // reload, as the answer is fetched once. Clearing the promise lets the next claimed objective ask again.
      .catch(() => { emblemPiecesPromise = null; return { bg: new Map(), fg: new Map() }; });
  }
  return emblemPiecesPromise;
}

// Dye colours for the guild emblems: id to hex, the cloth value of each. base_rgb is not the colour
// (it is the reference each material transforms); /v2/colors publishes the colour after the shift.
// Baked in because ?ids=all is far larger. An id that is not here falls back to a dark ink.
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

// Parsed on first sight, not at load.
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

// The dye, untouched: with the emblem's own backdrop underneath there is nothing to correct. The
// fallback covers a dye added to the game after the table was written.
function emblemInk(hex) {
  const n = hex ? parseInt(hex, 16) : NaN;
  if (!Number.isFinite(n)) return [0.09, 0.07, 0.04];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// The emblem as a stack of tinted layers, bottom first.
// The foreground's FIRST layer is not drawn: it is the whole device in base red and the later layers are
// the masks for the coloured regions, so drawing it paints the device wrong. The background has one layer.
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

// One filter per colour, built on first use in the defs it is given. Shared by the map and the detail panel.
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

// Everything the emblem needs, resolved together. Keyed by guild and kept as the promise, so six
// markers of one guild share one request.
const emblemPending = new Map();

function guildEmblem(guildId) {
  if (!emblemPending.has(guildId)) {
    // true: the stored copy is good enough for a thumbnail-sized badge.
    const pending = Promise.all([getGuildInfo(guildId, true), getEmblemPieces()])
      .then(([info, pieces]) => ({ info, layers: emblemLayers(info, pieces) }));
    // Dropped if it fails so the next marker can retry; a kept rejection would blank that guild's emblem.
    pending.catch(() => emblemPending.delete(guildId));
    emblemPending.set(guildId, pending);
  }
  return emblemPending.get(guildId);
}

// As with the catalogue, the result serves the next drawing.
function refreshSectorsSoon(mapId) {
  fetchJsonCached(
    `${API_BASE}/continents/2/floors/3/regions/7/maps/${encodeURIComponent(mapId)}/sectors?ids=all`)
    .then((list) => {
      const arr = (Array.isArray(list) ? list : []).filter((x) => Array.isArray(x.bounds));
      if (arr.length) sectorCache.set(mapId, arr);
    })
    .catch(() => { /* the baked copy stands */ });
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
  // Only a real answer is kept, as in getGuildInfo: a cached empty one would blank that map for the session.
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

// Tier is not in the objective data: it is how many upgrade steps the yaks have paid for. yaks_required
// is the cost of one step, not the running total, which is why this sums as it goes.
function objectiveTier(meta, ob) {
  const line = upgradeCatalogue && upgradeCatalogue.get(meta.upgrade_id);
  if (!line || !Array.isArray(line.tiers)) return null;
  const yaks = Number(ob.yaks_delivered || 0);
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

// Where each waypoint stands, in the objectives' coordinates, from the permanent points of interest (the
// "Emergency Waypoint" entries belong to the tactic and come and go). Baked in because they do not move.
// x, y and the point's own id, which a chat link is made of (waypointChat).
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

// The game's chat link for a point of interest: the byte 4, then the id as four little-endian bytes,
// base64'd between [& and ]. Built here because a wrong character is a link that goes nowhere.
function waypointChat(poiId) {
  if (!poiId) return null;
  const b = [4, poiId & 255, (poiId >> 8) & 255, (poiId >> 16) & 255, (poiId >> 24) & 255];
  return `[&${btoa(String.fromCharCode(...b))}]`;
}

// Straight to the clipboard, with the old way behind it: the modern API needs a secure context and permission.
function copyChatLink(text) {
  const legacy = () => {
    try { return legacyCopy(text); }
    catch { return false; }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, legacy);
  }
  return Promise.resolve(legacy());
}

// Eternal Battlegrounds, placed by eye: the real bearings (100 to 158 degrees) all point into the claim
// badge. Offsets are in units of the marker's own radius, x right and y down.
const WAYPOINT_NUDGE = Object.freeze({
  // Overlook, red's keep. Tucked in until it just laps the icon's edge.
  '38-1': [-1.00, 0.74],
  // Valley, blue's keep.
  '38-2': [-1.08, 0.64],
  // Lowlands, green's keep. Clear of the tier shields (to 0.76r across) and the claim badge (from 0.09r down).
  '38-3': [1.32, -0.44],
  // Stonemist. Low and left, the one quarter the claim badge never reaches.
  '38-9': [-0.86, 0.78],
});

// The team whose spawn a keep belongs to: a garrison to its map's home
// team, a side keep to the invader whose spawn lies just south of it,
// each Eternal Battlegrounds keep to its own colour. No API field names
// it. A keep missing here has only its upgrade.
const KEEP_SPAWN_TEAM = Object.freeze({
  '38-1': 'red', '38-2': 'blue', '38-3': 'green',
  '1099-113': 'red', '1099-106': 'green', '1099-114': 'blue',
  '96-37': 'blue', '96-33': 'red', '96-32': 'green',
  '95-37': 'green', '95-33': 'blue', '95-32': 'red',
});

// Does this objective have a waypoint? No API field says, and the upgrade catalogue is not the whole
// answer: a keep held by its spawn team has one at any tier, tier 0 included. Any other keep, and
// Stonemist, has one once the catalogue's waypoint upgrade is built. It says the waypoint EXISTS, not
// that it is usable.
function hasWaypoint(ob, tierInfo) {
  if (ob && ob.type === 'Keep') {
    const team = KEEP_SPAWN_TEAM[ob.id];
    if (team && String(ob.owner || '').toLowerCase() === team) return true;
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

// Held off to the side, in the direction the waypoint really lies. Only the bearing is kept, not the
// distance: drawn to scale the badge would land underneath the icon it belongs to.
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

  // Bearing, clockwise from straight up, checked against what is parked around the marker: the tier shields
  // hold the top from -46 to 46 degrees to about 1.0r, and the claim badge sits at 133 degrees out to roughly 1.8r.
  let a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  let out = Math.min(Math.max(d, r * 1.22), r * 1.7);

  if (a < 45 || a > 315) {
    // Above the shields. Pushing outward keeps the real bearing.
    out = Math.max(out, r * 1.55);
  } else if (a > 95 && a < 190) {
    // Straight into the claim badge, where all four EBG waypoints lie. Clearing a box that deep would strand
    // the icon next to another marker, so it takes the upper left, the one corner nothing else uses.
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

// The heraldic shield both badges are cut from, centred on (cx, cy).
function shieldPath(cx, cy, w, h, cls) {
  const x = cx - w / 2, y = cy - h / 2;
  return svgEl('path', {
    class: cls,
    d: `M${x} ${y}h${w}v${h * 0.5}`
      + `q0 ${h * 0.32} ${-w / 2} ${h * 0.5}`
      + `q${-w / 2} ${-h * 0.18} ${-w / 2} ${-h * 0.5}z`,
  });
}

// The kills a map shows over the span of its window. The tab's title and
// the corner read it through this one function, so the figures cannot part.
function fightCount(rates, type) {
  return {
    kills: Math.round((rates.per.get(type) || 0) * rates.span / 600000),
    mins: Math.round(rates.span / 60000),
  };
}

const HUD_EXPLAIN = {
  fights: 'Player kills on this map in the last 10 minutes. Orange swords mark the busiest map, past 50.',
};
const HUD_RESET_TIP = 'Counting starts about 10 minutes after the reset: there is nothing earlier this week to compare with.';
const HUD_NO_WINDOW_TIP = 'Not enough kill data to count 10 minutes.';

// "20 s", "41 min", "2 h 5 min": how long ago, for the balloons.
function ageWords(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// The two corners over the map: kills on the left, on the right the age of the match's data
// (matchScoreRoseAt). Text on a shadow, no box; they go while the map is zoomed. Built once per map;
// paint() rewrites them in place, so the status region keeps its identity.
function buildMapCorners(wrap, matchId) {
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
  const tips = { fights: HUD_EXPLAIN.fights, when: '' };
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
    if (hover) btn.title = tips[key];
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = openKey === key;
      close();
      if (was) return;
      openKey = key;
      note.textContent = tips[key];
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
  // Line one: the number and "kills" with its window. Line two, only when the
  // number is old: where its data ends.
  const big = mk('span', 'wvw-hud-big');
  const small = mk('span', 'wvw-hud-small');
  const smallSep = mk('span');
  const smallMins = mk('span');
  const smallLong = mk('span', 'wvw-hud-long');
  const smallShort = mk('span', 'wvw-hud-short');
  const smallTail = mk('span');
  smallTail.append(smallSep, smallMins, smallLong, smallShort);
  small.append('kills', smallTail);
  const line1 = mk('span', 'wvw-hud-line');
  line1.append(big, small);
  const lead = mk('span');
  const smallTime = mk('time', 'wvw-hud-when');
  const smallMark = mk('span');
  const line2 = mk('span', 'wvw-hud-small wvw-hud-small2');
  line2.append(smallMark, lead, smallTime);
  const fightsBtn = mk('button');
  const txt = mk('span', 'wvw-hud-txt');
  txt.append(line1, line2);
  fightsBtn.append(swords, txt);
  const left = corner('l', 'fights', fightsBtn);

  const ago = mk('time', 'wvw-hud-ago');
  const mark = mk('span', 'wvw-hud-mark');
  const word = mk('span', 'wvw-hud-word', 'data from ');
  const val = mk('span', 'wvw-hud-when');
  ago.append(mark, word, val);
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
  const setTip = (key, btn, text) => {
    if (text === tips[key]) return;
    tips[key] = text;
    if (hover) btn.title = text;
    if (openKey === key) note.textContent = text;
  };
  // The kills side, from killView for the map on show. No window: a dash and only "kills", never 0 from
  // a window nobody counted. Four looks: current; old for a normal reason (a slow map); old with no proof
  // yet; old for an abnormal one (API behind or map frozen: "data up to HH:MM ⚠", number dimmed, the sign
  // and the words being the signal, not the colour). `at`: when the score last rose.
  const paintKills = (view, type, isStale, at) => {
    const rates = view && view.rates;
    const line = rates && type ? fightCount(rates, type) : null;
    const odd = !!line && !!view.clock && (isStale || !!view.strange);
    const old = !!line && !!view.clock && (odd || view.silence > KILLS_QUIET_MS);
    // A window over 15 min takes two lines too: no data reached us for a while.
    const two = old || (!!line && view.long);
    const hole = !!line && view.longOk && !old;
    const unproven = old && !odd && (!view.alive || view.silence <= KILLS_STEP_MS);
    put(big, line ? String(line.kills) : '–');
    smallTail.hidden = !line;
    left.classList.toggle('is-dim', odd);
    left.classList.toggle('is-two', two);
    line2.hidden = !two;
    put(smallSep, line ? (two ? ' in ' : ' · ') : '');
    put(smallMins, line ? String(line.mins) : '');
    put(smallLong, line ? ' min' : '');
    put(smallShort, line ? 'm' : '');
    put(lead, hole ? 'data gap ' : two ? (old && !odd && !unproven ? (view.still ? 'no new kills since before ' : 'no new kills since ') : 'data up to ') : '');
    put(smallMark, odd ? '\u26a0\u00a0' : '');
    if (hole) {
      put(smallTime, `${hhmm(view.gap.from)}\u2013${hhmm(view.gap.to)}`);
      smallTime.removeAttribute('datetime');
    } else if (two) {
      // Still all along, the oldest reading is not where the data stops.
      const at = (odd || unproven) && view.still ? view.upTo : view.clock;
      put(smallTime, hhmm(at));
      smallTime.dateTime = new Date(at).toISOString();
    } else {
      put(smallTime, '');
      smallTime.removeAttribute('datetime');
    }
    let text;
    if (!line) {
      const wait = view && view.counting;
      text = view && view.noWindow === 'reset' ? HUD_RESET_TIP
        : wait && wait.ready > Date.now()
          ? `Counting since ${hhmm(wait.since)}, ready about ${hhmm(wait.ready)}: the kill history does not reach 10 minutes back yet.`
          : HUD_NO_WINDOW_TIP;
    } else {
      const t = hhmm(view.clock);
      const behind = (fallback) => hhmm(isStale && at ? at : fallback);
      // The tail names the stall only when it, not the pace, kept the swords off.
      const tail = view.jumpHeld
        ? ` No swords: the last jump came after ${Math.round(view.prevRun / 60000)} min without new kill data.` : '';
      if (view.long) {
        text = `${line.kills} kills in the ${line.mins} min up to ${t}. No kill data reached us between ${hhmm(view.gap.from)} and ${hhmm(view.gap.to)}.`
          + (hole ? ' The swords count the pace per 10 minutes.' : '')
          + (odd ? ` The game's API has been behind since ${behind(view.clock)}, so this is not now.` : unproven ? ` No newer data from the game's API since ${t} yet.` : old ? ` No new kills since ${t}, as on a quiet map.` : '') + tail;
      } else if (odd && view.still) {
        text = `The kill count has not moved from ${t}, the oldest reading, to ${hhmm(view.upTo)}. The game's API has been behind since ${behind(view.upTo)}, so this is not now.`;
      } else if (unproven && view.still) {
        text = `The kill count has not moved from ${t}, the oldest reading, to ${hhmm(view.upTo)}. No newer data from the game's API yet: an empty map or the API behind, too soon to tell.`;
      } else if (unproven) {
        text = `${line.kills} kills in the ${line.mins} min up to ${t}. No newer data from the game's API yet: a quiet map or the API behind, too soon to tell.${tail}`;
      } else if (odd) {
        text = `${line.kills} kills in the ${line.mins} min up to ${t}. The game's API has been behind since ${behind(view.clock)}, so this is not now.${tail}`;
      } else if (old && view.still) {
        text = `No new kills since before ${t}, as on an empty map: the kill history goes back to ${t} and the count has not moved in it. ${line.kills} kills in the last ${line.mins} min.`;
      } else if (old) {
        text = `No new kills since ${t}, as on a quiet map. ${line.kills} kills in the ${line.mins} min up to then.${tail}`;
      } else {
        text = `Player kills on this map in the last ${line.mins} minutes. Orange swords mark the busiest map, past 50.${tail}`;
      }
    }
    setTip('fights', fightsBtn, text);
  };
  let stale = null;
  const state = {
    // view: killView's answer for this match (null before one); type: the
    // map on show; at: ms the score last rose, 0 if unknown. The kills show
    // whenever the age does.
    paint(view, type, at) {
      left.hidden = !at;
      right.hidden = !at;
      if (!at) { paintKills(view, type, false, 0); stale = null; return; }
      const age = Math.max(0, Date.now() - at);
      const isStale = age > HUD_STALE_MS;
      paintKills(view, type, isStale, at);
      ago.classList.toggle('is-stale', isStale);
      ago.dateTime = new Date(at).toISOString();
      const mins = Math.floor(age / 60000);
      // Past the limit the sign is the signal, never the colour alone.
      put(mark, isStale ? '⚠ ' : '');
      put(val, hhmm(at));
      const answered = gameAnsweredAt.get(matchId);
      const late = isStale ? `, ${ageWords(age)} ago` : '';
      const kept = newestMatches.get(matchId);
      // The body on show decides the wording, not the game's last answer: ours may be the newer.
      const fromCopy = !!answered && !!kept && latestBodyAt.has(kept.match);
      setTip('when', whenBtn, fromCopy
        ? `Score last changed at ${hhmm(at)}${late}, read by our server. The game last answered this page ${ageWords(Date.now() - answered)} ago.`
        : `Score last changed at ${hhmm(at)}${late}. This page checks the game every 30 s; `
          + `${answered ? `last answer ${ageWords(Date.now() - answered)} ago` : 'no answer yet'}.`
          + " The game's data runs about 40 s behind play.");
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
// Five minutes (wiki), on every objective but sentries, during which the guards cannot be hurt: it
// answers "can I take it back yet" rather than "who owns this".
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

// Crossed swords and a countdown, under the marker. The group carries its own expiry in a data
// attribute, so the one-second tick sweeps the DOM with no registry to keep in step with repaints.
function riBadge(r, ob) {
  // Ruins have no guards, so there is nothing to protect.
  if (!ob || ob.type === 'Ruins') return null;
  const left = riLeft(ob.last_flipped);
  if (!left) return null;
  const g = svgEl('g', { class: 'wvw-ri' });
  g.dataset.until = String(new Date(ob.last_flipped).getTime() + RI_MS);
  // No number in the tip: it is written on the thirty-second repaint while the clock ticks every second.
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

// Rewrites the clocks and drops the badges whose five minutes are up. Text only, no fetch, so it can
// run every second beside the thirty-second refresh.
function tickRi(root) {
  for (const g of root.querySelectorAll('.wvw-ri')) {
    const left = Number(g.dataset.until) - Date.now();
    if (!(left > 0)) { g.remove(); continue; }
    const t = g.querySelector('text');
    if (t) t.textContent = riClock(left);
  }
}

// The guild's emblem on a gold shield at the marker's lower left, larger than the tier shields so
// claimed and upgraded never get confused. The shield is drawn at once and the emblem drops in when the
// lookup lands, so a slow guild call never holds up the map.
function claimBadge(r, guildId, emblemFilter) {
  // Pulled in over the disc rather than hung off its corner: a full radius out it reads as a second object.
  const w = r * 1.12, h = w * 1.06;
  const cx = r * 0.74, cy = r * 0.68;
  const g = svgEl('g', { class: 'wvw-claim' });
  // Two shields, one inside the other: the bright rim and the darker field it frames.
  g.appendChild(shieldPath(cx, cy, w, h, 'claim-rim'));
  g.appendChild(shieldPath(cx, cy, w * 0.82, h * 0.82, 'claim-field'));
  guildEmblem(guildId).then(({ layers }) => {
    if (!layers.length) return;
    // A real emblem has a device inside a backdrop; any smaller and the
    // inner shape is gone.
    paintEmblem(g, layers, {
      x: cx - w * 0.38, y: cy - h * 0.39, w: w * 0.76, h: w * 0.76,
    }, emblemFilter);
  }).catch(() => { /* the shield alone still says claimed */ });
  return g;
}

// One shield per tier along the TOP of the marker, none at tier 0, laid out as the game does: one dead
// centre, two flanking it, three with one back in the centre. Degrees from straight up.
const TIER_ANGLES = [null, [0], [-24, 24], [-46, 0, 46]];

function tierShields(r, tier) {
  const g = svgEl('g', { class: 'wvw-tierpips' });
  const angles = TIER_ANGLES[tier];
  if (!angles) return g;
  const w = r * 0.42, h = w * 1.15;
  // At w*1.15 tall, a centre of 0.76r lands each shield's top edge on the outline at 1.0r.
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
  // Who holds what, and only that. Empty means nobody knows yet, a real state and not an error.
  const ownersOf = (data, isLive) => {
    const byId = new Map();
    if (isLive) for (const ob of (data && data.objectives) || []) byId.set(ob.id, ob);
    return byId;
  };
  let owners = ownersOf(mapData, matchIsLive(match));

  // The markers come from the catalogue, never from the match: what exists on a map and where it sits do
  // not change at a relink, so the map is always whole and only ownership waits. No owner is drawn Neutral.
  const blank = (meta) => ({ id: meta.id, type: meta.type, owner: 'Neutral' });
  const pts = [];
  for (const meta of catalogue.values()) {
    if (meta.map_id !== mapData.id) continue;
    if (MAP_SKIP_TYPES.has(meta.type)) continue;
    // coord, not label_coord: label_coord is where the game writes the objective's *name*, clear of the
    // building. The EBG mercenary camps have an empty coord; MERC_COORD stands in for them.
    const at = (meta.coord && meta.coord.length) ? meta.coord
      : (MERC_COORD[meta.id] || meta.label_coord);
    if (!at) continue;
    pts.push({ ob: owners.get(meta.id) || blank(meta), meta, x: at[0], y: at[1] });
  }

  // The viewBox comes from the sector outlines, so nothing has to agree about map bounds.
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

  // One flattening filter per colour on this map, built on first use. The alpha channel passes through,
  // so only the layer's shape survives, filled with the guild's own dye.
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

  // Three passes, not one: a single pass lets the next sector's fill paint over the previous outline,
  // where the line between two owners matters most. The dark pass also buries the pale sector borders
  // printed into the render.
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
    tinted.push({ id: sec.id, fill: poly, edge, points });
  }
  land.appendChild(fills);
  land.appendChild(unders);
  land.appendChild(overs);
  svg.appendChild(land);

  const markers = svgEl('g', {});
  pts.sort((a, b) => OBJ_DRAW_ORDER.indexOf(a.ob.type) - OBJ_DRAW_ORDER.indexOf(b.ob.type));
  const nodes = [];

  // Everything about a marker that can change while you look at it, in one function, so a live update runs
  // the same code as the first draw. The listeners live on the group itself, so emptying it is safe, and the
  // selected class is carried across.
  // What each marker was last drawn from, so the 30 s refresh redraws only the objectives that changed. The
  // tier and the waypoint are part of the key: they come from upgradeCatalogue, which usually lands after the
  // first drawing, and a key of the objective alone would leave those markers without shields for good.
  const drawnFrom = new WeakMap();
  const markerKey = (p) => {
    const tierInfo = objectiveTier(p.meta, p.ob);
    return JSON.stringify(p.ob) + '|' + (tierInfo ? tierInfo.tier : '-')
      + '|' + hasWaypoint(p.ob, tierInfo);
  };
  const paintMarker = (g, p) => {
    drawnFrom.set(g, markerKey(p));
    const r = OBJ_SIZE[p.ob.type] || 14;
    const owner = String(p.ob.owner || 'neutral').toLowerCase();
    const tierInfo = objectiveTier(p.meta, p.ob);
    const tier = tierInfo ? tierInfo.tier : 0;
    const selected = g.classList.contains('is-selected') ? ' is-selected' : '';
    const lit = g.classList.contains('is-lit') ? ' is-lit' : '';
    g.setAttribute('class', `wvw-marker own-${owner} tier-${tier}${selected}${lit}`);
    while (g.firstChild) g.removeChild(g.firstChild);

    // The icon's own disc, and nothing past it: a wider target swallows the
    // badges hanging off the marker, which have to answer for themselves.
    g.appendChild(svgEl('circle', { class: 'hit', r }));
    // The icon already carries the team colour: a disc behind would only show as a second ring.
    const markerSrc = markerIcon(p.ob.type, p.ob.owner);
    if (markerSrc) {
      const icon = svgEl('image', {
        class: 'pip', href: markerSrc,
        x: -r, y: -r, width: r * 2, height: r * 2,
      });
      icon.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', markerSrc);
      g.appendChild(icon);
    }
    const wp = hasWaypoint(p.ob, tierInfo);
    if (wp) g.appendChild(waypointBadge(r, p));
    if (p.ob.claimed_by) g.appendChild(claimBadge(r, p.ob.claimed_by, emblemFilter));
    // Last, so the shields sit over the claim badge instead of being
    // crossed by it.
    if (tier) g.appendChild(tierShields(r, tier));
    const ri = riBadge(r, p.ob);
    if (ri) g.appendChild(ri);
    const ringUntil = missedRingUntil(match.id, p.meta.id);
    if (ringUntil) g.appendChild(missedRingMark(r, ringUntil));
    const tip = svgEl('title', {});
    // The same words the detail panel uses.
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
    g.dataset.obj = p.meta.id;
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

  // ---- the focus ----------------------------------------------------
  // What a spec (focusMatches) picks stays as drawn, its marker a quarter bigger, its sector ringed in the
  // owner's colour; the rest goes a step darker. The ground is darkened by a black veil with the lit sectors
  // cut out (even-odd): the same pixels as a brightness(.55) filter without drawing the terrain twice (a
  // second <image> asks the server again). The markers are darkened by that filter (css/maps.css,
  // .is-focused). Each sector holds exactly one objective (wvw-static.js), so the marker names its sector.
  // The layer is rebuilt only when what it shows moved, so the 30 s repaint leaves the screen as it was.
  let focus = null;
  let focusKey = '';
  const paintFocus = (spec) => {
    focus = spec || null;
    svg.classList.toggle('is-focused', !!focus);
    const litSectors = new Set();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const on = !!focus && focusMatches(focus, p.meta.id, String(p.ob.owner || 'neutral').toLowerCase(), p.ob.type);
      nodes[i].classList.toggle('is-lit', on);
      if (on && p.meta.sector_id) litSectors.add(p.meta.sector_id);
    }
    const lit = tinted.filter((t) => litSectors.has(t.id));
    const key = focus ? JSON.stringify(lit.map((t) => `${t.id} ${t.edge.getAttribute('class')}`)) : '';
    if (key === focusKey) return;
    focusKey = key;
    const old = svg.querySelector(':scope > .wvw-focus');
    if (old) old.remove();
    if (!focus) return;
    const layer = svgEl('g', { class: 'wvw-focus' });
    // Three times the frame each way: past any letterboxing of the viewBox.
    const outer = `M${minX - fullW} ${minY - fullH}h${fullW * 3}v${fullH * 3}h${-fullW * 3}z`;
    const holes = lit.map((t) => `M${t.points.replace(/ /g, 'L')}z`).join('');
    layer.appendChild(svgEl('path', { class: 'wvw-focus-veil', d: outer + holes, 'fill-rule': 'evenodd' }));
    const outline = svgEl('g', { class: 'wvw-focus-outline', 'stroke-width': edgeW * 0.44 * 2.4 });
    for (const t of lit) outline.appendChild(svgEl('polygon', { class: t.edge.getAttribute('class'), points: t.points }));
    layer.appendChild(outline);
    svg.insertBefore(layer, markers);
  };

  // ---- zoom and pan -------------------------------------------------
  // The viewBox is the camera. Markers are pinned to the ground but damped (MARKER_FOLLOW).
  const view = { x: minX, y: minY, w: fullW, h: fullH };

  // The full picture, once the terrain is drawn wider on screen than the lite one has pixels. Decoded off
  // to the side and laid over the lite one once the new node has loaded and a frame has shown both: swapping
  // the href leaves the ground blank while the file decodes. The node asks for the file again (a
  // revalidation), hence waiting on its own load. Width comes from a ResizeObserver, so a zoom never has to
  // ask for layout.
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
    // click to the wrapper, so the button's own click listener never runs.
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
    // Keep the point grabbed at pointerdown under the cursor. Measuring
    // against the live view.x, which this handler moves, would make the map
    // creep away from the pointer.
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

  // Says which half is missing. The map is drawn and readable either way: not an error state.
  const waiting = document.createElement('p');
  waiting.className = 'wvw-waiting';
  waiting.textContent = "Just after reset — ArenaNet hasn't published this map yet";
  waiting.hidden = owners.size > 0;
  wrap.appendChild(waiting);

  // Repaint from fresher objective data without rebuilding anything: same nodes, same viewBox, so the zoom
  // and the selected objective survive.
  wrap.applyLive = (freshMapData, isLive) => {
    owners = ownersOf(freshMapData, isLive);
    for (let i = 0; i < pts.length; i++) {
      // Back to Neutral when an owner goes away, rather than keeping the last one seen: a blank list mid-relink
      // must not leave a map claiming an ownership nobody asserts.
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
    paintFocus(focus);   // owners moved: who is lit may have too, in the same frame
  };

  // The ring on markers that changed hands without being repainted, and a
  // chip's tap: the same as a click on the marker.
  wrap.ringChanged = () => {
    for (let i = 0; i < pts.length; i++) {
      const until = missedRingUntil(match.id, pts[i].meta.id);
      if (until && !nodes[i].querySelector('.wvw-ring')) {
        nodes[i].appendChild(missedRingMark(OBJ_SIZE[pts[i].ob.type] || 14, until));
      }
    }
  };
  wrap.selectObjective = (id) => {
    const i = pts.findIndex((p) => p.meta.id === id);
    if (i >= 0) nodes[i].dispatchEvent(new MouseEvent('click'));
  };
  wrap.paintFocus = paintFocus;

  return wrap;
}


// ---- the score bar --------------------------------------------------
// One segment per side, as wide as that side's share of THIS map's tick, not the match total (identical
// on all four tabs): whoever is running the map fills the bar, and a side that stopped scoring shrinks out.
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
  return bar;
}

// ---- the map scoreboard ---------------------------------------------
// The four types that pay (Ruins and Mercenary tick zero), smallest first, the order of the game's panel.
const SCORE_TYPES = ['Camp', 'Tower', 'Keep', 'Castle'];

// What each side holds across the maps it is handed: the tick they add up to, and how many of each
// structure, from the objective lists the standings already fetched.
function tallyMaps(maps, isLive) {
  const by = new Map();
  for (const c of COLORS) by.set(c, { ppt: 0, counts: new Map() });
  // Which of the four are in play: across the match all four; over one borderland the castle drops out.
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

// ---- the focus: a team, a type, or a few objectives lit on the map ----
// A spec is { ids: [objective ids] } or { color, type }, either of the two
// may be null. The board picks { color, type } (paintBoardFocus); a chip
// of the "What happened" block lights { ids } while pointed at.
const FOCUS_TAP_MS = 2500;   // a tapped chip's objective stays lit this long
const FOCUS_COLOR_WORD = Object.freeze({ red: 'Red', blue: 'Blue', green: 'Green' });
const FOCUS_TYPE_PLURAL = Object.freeze({ Camp: 'camps', Tower: 'towers', Keep: 'keeps', Castle: 'castles' });

// Set while a tier's maps are open: lets go of the board's pick and says
// whether there was one. Esc does that first and closes the popover only
// on the next press - so it runs before popover.js's listener, in capture.
let mapFocusEscape = null;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !mapFocusEscape || !mapFocusEscape()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// owner is lower case ('blue'), type the API's ('Tower').
function focusMatches(spec, id, owner, type) {
  if (spec.ids) return spec.ids.includes(id);
  return (!spec.color || owner === spec.color) && (!spec.type || type === spec.type);
}

// "Blue only", "Blue towers", "Towers only".
function focusWords(pick) {
  const color = pick.color ? FOCUS_COLOR_WORD[pick.color] || '' : '';
  const types = pick.type ? FOCUS_TYPE_PLURAL[pick.type] || '' : '';
  if (color && types) return `${color} ${types}`;
  if (color) return `${color} only`;
  return `${types.charAt(0).toUpperCase()}${types.slice(1)} only`;
}

// The board's header label without a pick: on a phone the name column is
// a few letters wide, so it says "Held". The query matches maps.css.
const BOARD_PHONE = window.matchMedia('(max-width:480px)');
const heldWords = () => (BOARD_PHONE.matches ? 'Held' : 'Objectives held');
BOARD_PHONE.addEventListener('change', () => {
  for (const l of document.querySelectorAll('.wvw-board-head .wvw-board-team')) {
    if (!l.querySelector('.wvw-focus-pill')) l.textContent = heldWords();
  }
});

// The board's half of a pick: the chosen row, cell or column marked, and
// the label "Objectives held" turned into the button that clears it.
// Called after every paintMapBoard, which rebuilds the board.
function paintBoardFocus(board, pick, clear) {
  const on = (el, yes) => {
    el.classList.toggle('is-picked', yes);
    if (el.getAttribute('role') === 'button') el.setAttribute('aria-pressed', yes ? 'true' : 'false');
  };
  for (const el of board.querySelectorAll('[data-focus-color], [data-focus-type]')) {
    const color = el.dataset.focusColor || null;
    const type = el.dataset.focusType || null;
    on(el, !!pick && pick.color === color && pick.type === type);
  }
  // The row's name says the row is picked, for a screen reader too.
  for (const row of board.querySelectorAll('.wvw-board-row[data-focus-color]')) {
    const name = row.querySelector('.wvw-board-team');
    if (name) on(name, row.classList.contains('is-picked'));
  }
  const head = board.querySelector('.wvw-board-head');
  const label = head && head.querySelector('.wvw-board-team');
  if (!label) return;
  head.classList.toggle('has-pick', !!pick);
  const pill = label.querySelector('.wvw-focus-pill');
  if (!pick) {
    if (pill || label.textContent !== heldWords()) label.textContent = heldWords();
    return;
  }
  const words = focusWords(pick);
  if (pill && pill.dataset.words === words) return;
  label.textContent = '';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'wvw-focus-pill';
  b.dataset.words = words;
  if (pick.color) {
    const dot = document.createElement('span');
    dot.className = `wvw-focus-dot own-${pick.color}`;
    dot.setAttribute('aria-hidden', 'true');
    b.appendChild(dot);
  }
  const text = document.createElement('span');
  text.className = 'wvw-focus-words';
  text.textContent = words;
  const x = document.createElement('span');
  x.className = 'wvw-focus-x';
  x.setAttribute('aria-hidden', 'true');
  x.textContent = '\u2715';
  b.append(text, x);
  b.setAttribute('aria-label', `Showing ${words}. Show everything again`);
  b.title = `Showing ${words} \u2014 click to show everything`;
  b.addEventListener('click', (e) => { e.stopPropagation(); clear(); });
  label.appendChild(b);
}

// One row per side, the leader on top, totalled over the whole match (the bar over the map is this map,
// the board is the war). Sorting by tick can swap rows on the 30 s refresh, so each carries the team
// colour as well as the name.
function paintMapBoard(board, match, isLive) {
  board.textContent = '';
  const { by, types } = tallyMaps(match && match.maps, isLive);
  const rows = COLORS.map((c) => ({ color: c, ...by.get(c) }));
  if (!isLive || !rows.some((r) => r.ppt || r.counts.size)) {
    board.hidden = true;
    return;
  }
  board.hidden = false;
  // Ties keep the fixed colour order, so a 0-0 map does not shuffle on every refresh.
  rows.sort((a, b) => (b.ppt - a.ppt) || (COLORS.indexOf(a.color) - COLORS.indexOf(b.color)));

  // The grid is set here rather than in the stylesheet because the
  // column count is the map's, not the design's. el.style goes through
  // the CSSOM, which the page's CSP does not govern.
  const grid = `repeat(${types.length}, var(--board-cell))`;

  // The header the game's panel has too, with the column names filled in.
  const head = document.createElement('div');
  head.className = 'wvw-board-row wvw-board-head';
  const headLabel = document.createElement('span');
  headLabel.className = 'wvw-board-team';
  headLabel.textContent = heldWords();
  head.appendChild(headLabel);
  const headCells = document.createElement('span');
  headCells.className = 'wvw-board-counts';
  headCells.style.gridTemplateColumns = grid;
  for (const type of types) {
    const h = document.createElement('span');
    h.textContent = type;
    // A column picks that type on the map, whoever holds it.
    h.dataset.focusType = type;
    h.setAttribute('role', 'button');
    h.tabIndex = 0;
    h.title = `Show only the ${FOCUS_TYPE_PLURAL[type] || type} on the map`;
    headCells.appendChild(h);
  }
  head.appendChild(headCells);
  const headPpt = document.createElement('span');
  headPpt.className = 'wvw-board-ppt';
  headPpt.textContent = 'PPT';
  // Every map added up, not this one: the bar over the map is the
  // per-map reading, and saying "this map" here would contradict it.
  headPpt.title = 'Points per tick, every map added up';
  head.appendChild(headPpt);
  board.appendChild(head);

  for (const r of rows) {
    const line = document.createElement('div');
    line.className = `wvw-board-row own-${r.color}`;
    // Anywhere on the row picks the team; a cell, the team and that type.
    line.dataset.focusColor = r.color;

    const name = document.createElement('span');
    name.className = 'wvw-board-team';
    const teamId = matchTeamId(match, r.color);
    name.textContent = teamId ? getTeamName(teamId) : r.color;
    name.title = name.textContent;
    name.setAttribute('role', 'button');
    name.tabIndex = 0;
    line.appendChild(name);

    const counts = document.createElement('span');
    counts.className = 'wvw-board-counts';
    counts.style.gridTemplateColumns = grid;
    for (const type of types) {
      const n = r.counts.get(type) || 0;
      const cell = document.createElement('span');
      // Zero still gets its cell so the columns line up across the rows. Faded almost out, as the game does.
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
      // Beside the icon, not under it: stacked, three rows push the popover
      // into a scrollbar.
      const n_ = document.createElement('b');
      n_.textContent = String(n);
      cell.appendChild(n_);
      cell.title = `${n} ${type}${n === 1 ? '' : 's'}`;
      cell.dataset.focusColor = r.color;
      cell.dataset.focusType = type;
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
      cell.setAttribute('aria-label', `${name.textContent}: ${cell.title}`);
      counts.appendChild(cell);
    }
    line.appendChild(counts);

    const ppt = document.createElement('span');
    ppt.className = 'wvw-board-ppt';
    ppt.textContent = `+${r.ppt}`;
    ppt.title = `${getTeamName(matchTeamId(match, r.color))}`
      + ` earns ${r.ppt} points per tick, every map added up`;
    line.appendChild(ppt);

    board.appendChild(line);
  }
}

// ---- the detail panel ------------------------------------------------
// How far along the next tier is, as x/y with a bar. The bar fills to the same fraction the numbers state;
// it is not progress within the current tier. At the top it says "max" and drops the bar but keeps the icon.
function yakCell(t) {
  const cell = document.createElement('span');
  cell.className = 'wvw-yakcell';

  // The game's caravan icon says what the pair of numbers counts in a column this narrow.
  const line = document.createElement('span');
  line.className = 'wvw-yaknum';
  const icon = document.createElement('img');
  icon.src = 'assets/icons/Event_Caravan.webp';
  // At the top tier the row label already says "Yaks", so the icon is decoration. On the way up the label
  // names the tier, and the icon is what says what is being counted.
  icon.alt = t.next ? 'yaks' : '';
  icon.width = 15;
  icon.height = 15;
  line.appendChild(icon);
  const n = document.createElement('b');
  n.textContent = t.next ? `${t.yaks}/${t.next.at}` : `${t.yaks} — max`;
  line.appendChild(n);
  cell.appendChild(line);

  // No bar at the top tier: a full bar reads as progress towards something that is not there.
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

// Breaks the list into the three questions it answers: whose it is, what it pays, how upgraded it is.
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
  // The same shields the map draws, in the same tier colour.
  const tierInfo = objectiveTier(meta, ob);
  if (tierInfo && tierInfo.tier > 0) {
    const chip = document.createElement('span');
    chip.className = `wvw-tierchip tierchip-${tierInfo.tier}`;
    // The same form the row below and the marker tooltip use; the number
    // stays, because "T3" is how the mode is spoken.
    chip.title = `T${tierInfo.tier} ${tierInfo.name}`;
    for (let i = 0; i < tierInfo.tier; i++) chip.appendChild(document.createElement('i'));
    name.appendChild(chip);
  }
  name.appendChild(document.createTextNode(meta.name || ob.id));
  panel.appendChild(name);

  const ownerColor = String(ob.owner || '').toLowerCase();
  const owned = COLORS.includes(ownerColor);
  const ownCls = owned ? `wvw-owner own-${ownerColor}` : null;

  // The type carries the very marker the map draws, in the holder's colour.
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
        // An SVG rather than an img, because the layers are tinted and stacked: the marker's drawing at a fifth
        // of the size, with its own defs and ids since it lives outside the map's SVG.
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
  // The game's own names for the tiers, straight out of the API.
  if (tierInfo) {
    // No "of 3": every objective in the mode has exactly three tiers.
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

  // Tactics, not the automatic tier upgrades (they follow from the yak count, summed above): what the
  // holding guild chose to install.
  // One field carries two kinds. An improvement is bought once and is simply on; a tactic sits in a slot
  // waiting for supply and a press, which is what an attack has to time around. So each gets a heading,
  // tactics first, as the game splits them. The API types both "Claimable" and, as far as we read it,
  // separates them only by the cost item's name ending in "Tactic" or "Improvement". Anything matching
  // neither is listed with the tactics, so a new kind of upgrade shows up instead of being swallowed.
  const isImprovement = (t) => {
    const cost = t && (t.costs || [])[0];
    return !!cost && /\bImprovement$/i.test(cost.name || '');
  };
  const installed = Array.isArray(ob.guild_upgrades) ? ob.guild_upgrades : [];

  // The catalogue is fetched once for the match when the popover opens, so a later install would show as a
  // bare "Upgrade 379". Fetched on sight instead; the panel repaints when it lands. The second check is
  // the brake: a repaint that changes nothing would ask again for ever.
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
  // Tactics first, so the column that collapses to the top row on a narrow screen is read first.
  listUpgrades('Tactics', tactics);
  listUpgrades('Improvements', improvements);
  if (cols.childElementCount) panel.appendChild(cols);
}

// ---- its pieces ----------------------------------------------------------
const missedHhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "05:03–05:33 PM" rather than "05:03 PM–05:33 PM" when both share the suffix.
function missedSpan(a, b) {
  const x = missedHhmm(a);
  const y = missedHhmm(b);
  const sx = /\s?[^\d:\s]+$/.exec(x);
  const sy = /\s?[^\d:\s]+$/.exec(y);
  if (sx && sy && sx[0] === sy[0]) return `${x.slice(0, -sx[0].length)}\u2013${y}`;
  return `${x}\u2013${y}`;
}

function missedFullName(objId) {
  const meta = objectiveCatalogue && objectiveCatalogue.get(objId);
  return String((meta && meta.name) || objId).trim();
}

// A name that fits a chip: "SM", "Garrison", "Bay", "Hills", or the first word.
function missedShortName(objId) {
  const name = missedFullName(objId);
  if (Object.prototype.hasOwnProperty.call(MISSED_SHORT_NAME, name)) return MISSED_SHORT_NAME[name];
  if (/ Bay$/.test(name)) return 'Bay';
  if (/ Hills$/.test(name)) return 'Hills';
  const words = name.split(/\s+/);
  if (name.length <= 12 || words.length === 1) return name;
  return words[0] === 'The' || words[0] === 'Temple' ? words.slice(0, 2).join(' ') : words[0];
}

function missedEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function missedImg(src, size) {
  const img = missedEl('img');
  img.src = src;
  img.alt = '';
  img.width = size;
  img.height = size;
  return img;
}

// A silver tower: the game's tower icon is a grey disc at this size.
function missedTower() {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { fill: 'currentColor', 'fill-rule': 'evenodd',
    d: 'M3 1.5h2.4v2h1.4v-2h2.4v2h1.4v-2H13v4.2l-1.6 1.4V15H4.6V7.1L3 5.7zM6.8 15v-3.2a1.2 1.2 0 0 1 2.4 0V15z' }));
  return svg;
}

// A 16 px chevron, pointing down; the CSS turns it up while the block is open.
function missedChevron() {
  const svg = svgEl('svg', { class: 'wvw-missed-chev', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d: 'M3.5 6 8 10.5 12.5 6', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

// The pulsing ring on a marker; recreated with the marker, as riBadge is.
function missedRingMark(r, until) {
  const g = svgEl('g', { class: 'wvw-ring' });
  g.appendChild(svgEl('circle', { class: 'wvw-ring-a', r: r * 1.25 }));
  g.appendChild(svgEl('circle', { class: 'wvw-ring-b', r: r * 1.25 }));
  setTimeout(() => g.remove(), Math.max(0, until - Date.now()) + 500);
  return g;
}

function missedChip(c, here, goTo, spot) {
  const map = MAP_TAB_NAME[c.map] || c.map;
  const b = missedEl('button', `wvw-chip own-${c.to}${here ? '' : ' is-other'}`);
  b.type = 'button';
  b.dataset.obj = c.id;
  b.dataset.map = c.map;
  const src = markerIcon(c.type, c.to);
  if (src) b.appendChild(missedImg(src, 16));
  b.appendChild(missedEl('span', 'wvw-chip-name', missedShortName(c.id)));
  // Who held it before: a dot in that colour.
  const from = missedEl('span', `wvw-chip-from own-${c.from}`);
  from.setAttribute('aria-hidden', 'true');
  b.appendChild(from);
  const words = `${missedFullName(c.id)} (${map}): taken by ${c.toName} from ${c.fromName}`;
  b.title = words;
  b.setAttribute('aria-label', words);
  b.addEventListener('click', (e) => { e.stopPropagation(); goTo(c.map, c.id); });
  // Pointed at or focused, its objective is lit on the map (on its own tab).
  const on = () => spot({ ids: [c.id] }, { map: c.map, el: b });
  const off = () => spot(null, { el: b });
  b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') on(); });
  b.addEventListener('pointerleave', off);
  b.addEventListener('focus', on);
  b.addEventListener('blur', off);
  return b;
}

// The block itself, at the top of the right-hand column. view: { matchId,
// side, tabs, type, goTo, spot, repaint }. Rebuilt only when what it shows moved.
function paintMissed(view) {
  const note = missedNoteFor(view.matchId);
  const shown = note && missedView(note);
  let box = view.side.querySelector('.wvw-missed:not(.is-leaving)');
  if (!note || (!shown.changes.length && !shown.kills)) {
    if (box) {
      box.classList.add('is-leaving');
      setTimeout(() => box.remove(), 200);
    }
    return;
  }
  const narrow = window.matchMedia(MISSED_NARROW).matches;
  // Folded on a phone until asked; open beside the map until hidden.
  const open = narrow ? note.open : note.wideOpen;
  const key = JSON.stringify([view.type, shown.since, shown.end, shown.sure, narrow, open, [...note.moreMaps].sort(),
    shown.perMap, shown.changes.map((c) => c.id), shown.kills]);
  if (box && box.dataset.key === key) return;
  if (!box) {
    box = missedEl('section', 'wvw-missed');
    view.side.insertBefore(box, view.side.firstChild);
  }
  box.dataset.key = key;
  box.dataset.kind = note.kind;
  box.textContent = '';
  box.classList.toggle('is-open', open);

  const away = note.kind === 'return';
  const span = shown.sure ? missedSpan(shown.since, shown.end) : `since before ${missedHhmm(shown.since)}`;
  const changes = shown.changes;

  const head = missedEl('button', 'wvw-missed-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  const title = missedEl('span', 'wvw-group wvw-missed-title');
  title.append(`${away ? 'What you missed' : 'What happened'} · `, missedEl('span', 'wvw-missed-time', span));
  head.appendChild(title);
  const counts = missedEl('span', 'wvw-missed-counts');
  const badge = (n, cls, icon, words) => {
    const b = missedEl('span', `wvw-missed-count ${cls}`);
    b.appendChild(icon ? missedImg(icon, 12) : missedTower());
    b.append(String(n));
    b.setAttribute('aria-label', words);
    counts.appendChild(b);
  };
  if (shown.kills) badge(shown.kills, 'is-kills', 'assets/icons/Event_Swords.webp', `${shown.kills} kill${shown.kills === 1 ? '' : 's'}`);
  if (changes.length) {
    badge(changes.length, 'is-objectives', null,
      `${changes.length} objective${changes.length === 1 ? '' : 's'} changed hands`);
  }
  if (counts.firstChild) title.append(' ', counts);
  head.appendChild(missedChevron());
  head.addEventListener('click', (e) => {
    e.stopPropagation();
    if (narrow) note.open = !open; else note.wideOpen = !open;
    note.moreMaps.clear();
    view.repaint();
  });
  box.appendChild(head);
  if (!open) return;

  const sub = missedEl('p', 'wvw-missed-sub',
    away ? 'While this tab was in the background' : 'While the game sent no updates');
  // One row per map that had a change or a kill, in the tabs' order: the map's
  // name (a button to its tab) and its kills, then the chips of that map.
  // The open map's chips are normal, the others a little quieter.
  const kills = new Map(shown.perMap.map((m) => [m.type, m.n]));
  const rows = [];
  for (const type of Object.keys(MAP_TAB_NAME)) {
    const list = changes.filter((c) => c.map === type);
    if (!list.length && !kills.has(type)) continue;
    const mapName = MAP_TAB_NAME[type];
    const here = type === view.type;
    const row = missedEl('div', `wvw-missed-row tint-${MISSED_MAP_TINT[type] || 'neutral'}${here ? '' : ' is-other'}`);
    const top = missedEl('div', 'wvw-missed-rowhead');
    const name = missedEl('button', 'wvw-missed-mapname');
    name.type = 'button';
    name.title = `Open ${mapName}`;
    name.appendChild(missedEl('span', `dot dot-${MISSED_MAP_TINT[type] || 'neutral'}`));
    name.append(mapName);
    name.addEventListener('click', (e) => { e.stopPropagation(); view.goTo(type, null, false); });
    top.appendChild(name);
    if (kills.has(type)) {
      const n = kills.get(type);
      const k = missedEl('span', 'wvw-missed-kills');
      k.setAttribute('aria-label', `${n} kill${n === 1 ? '' : 's'} on ${mapName}`);
      k.appendChild(missedEl('b', 'wvw-missed-killn', String(n)));
      k.append(n === 1 ? ' kill' : ' kills');
      top.appendChild(k);
    }
    row.appendChild(top);
    if (list.length) {
      const chips = missedEl('div', 'wvw-chips');
      const room = note.moreMaps.has(type) ? list.length : narrow ? MISSED_CHIPS_NARROW : MISSED_CHIPS_WIDE;
      for (const c of list.slice(0, room)) chips.appendChild(missedChip(c, here, view.goTo, view.spot));
      const hidden = list.length - Math.min(list.length, room);
      if (hidden > 0) {
        const more = missedEl('button', 'wvw-chip wvw-chip-more', `+${hidden}`);
        more.type = 'button';
        more.setAttribute('aria-label', `Show ${hidden} more on ${mapName}`);
        more.addEventListener('click', (e) => { e.stopPropagation(); note.moreMaps.add(type); view.repaint(); });
        chips.appendChild(more);
      }
      row.appendChild(chips);
    }
    rows.push(row);
  }
  const body = missedEl('div', 'wvw-missed-body');
  // Rows first on every width: on a phone they are what a tap opened it for.
  const parts = narrow ? [...rows, sub] : [sub, ...rows];
  for (const p of parts) body.appendChild(p);
  box.appendChild(body);
}

// ---- recent captures (the "Captures" tab) --------------------------------
// Camps to castles taken in the CAPTURES_WINDOW_MS up to the newest capture in
// the body, by last_flipped - not up to now: while the API repeats an old body
// the captures it knows stay listed instead of ageing out of a moving window.
const CAPTURES_WINDOW_MS = 30 * 60 * 1000;
const CAPTURES_MAX = 40;
const CAPTURE_TYPES = new Set(['Camp', 'Tower', 'Keep', 'Castle']);
// The tabs' pane (renderTierMapsContent). MAP_STACKED is css/maps.css's
// breakpoint, where the column goes under the map.
const MAP_STACKED = '(max-width: 760px)';
const PANE_ROOM = 80;    // px left under the board, stacked: room for charts later
const PANE_MIN = 210;    // px, stacked
const PANE_FLOOR = 150;  // px, beside the map: under this the column outgrows the map

function recentCaptures(match) {
  // A clock running ahead on the API's side must not set the window.
  const ceiling = Date.now() + 60000;
  let newest = 0;
  for (const map of missedMaps(match)) {
    for (const o of missedObjectives(map)) {
      const at = Date.parse(o && o.last_flipped);
      if (Number.isFinite(at) && at <= ceiling) newest = Math.max(newest, at);
    }
  }
  const out = [];
  for (const map of missedMaps(match)) {
    for (const o of missedObjectives(map)) {
      if (!o || typeof o.id !== 'string' || !CAPTURE_TYPES.has(o.type)) continue;
      const owner = missedOwner(o.owner);
      const at = Date.parse(o.last_flipped);
      if (owner === 'neutral' || !Number.isFinite(at) || at > newest || newest - at > CAPTURES_WINDOW_MS) continue;
      out.push({ at, id: o.id, type: o.type, owner, map: map.type });
    }
  }
  return out.sort((a, b) => (b.at - a.at) || a.id.localeCompare(b.id));
}

// The list, rebuilt only when what it shows moved. view: { box, match, goTo,
// spot }. A row lights its objective while pointed at; pressed, it opens the
// objective's map and lights it a moment, without selecting it - the list
// stays on screen.
function paintCaptures(view, items) {
  const shown = items.slice(0, CAPTURES_MAX);
  const key = JSON.stringify(shown);
  if (view.box.dataset.key === key) return;
  view.box.dataset.key = key;
  view.box.textContent = '';
  if (!shown.length) {
    view.box.appendChild(missedEl('p', 'wvw-caps-none', 'No recent captures.'));
    return;
  }
  for (const it of shown) {
    const map = MAP_TAB_NAME[it.map] || it.map;
    const row = missedEl('button', 'wvw-cap');
    row.type = 'button';
    row.dataset.obj = it.id;
    row.dataset.map = it.map;
    const time = missedEl('time', 'wvw-cap-time', missedHhmm(it.at));
    time.dateTime = new Date(it.at).toISOString();
    row.appendChild(time);
    const src = markerIcon(it.type, it.owner);
    if (src) row.appendChild(missedImg(src, 14));
    row.appendChild(missedEl('span', 'wvw-cap-name', missedShortName(it.id)));
    row.appendChild(missedEl('span', 'wvw-cap-map', map));
    const id = matchTeamId(view.match, it.owner);
    const words = `${missedFullName(it.id)} (${map}): taken by ${id ? getTeamName(id) : FOCUS_COLOR_WORD[it.owner]}`
      + ` at ${missedHhmm(it.at)}`;
    row.title = words;
    row.setAttribute('aria-label', words);
    row.addEventListener('click', (e) => { e.stopPropagation(); view.goTo(it.map, it.id, false); });
    const on = () => view.spot({ ids: [it.id] }, { map: it.map, el: row });
    const off = () => view.spot(null, { el: row });
    row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') on(); });
    row.addEventListener('pointerleave', off);
    row.addEventListener('focus', on);
    row.addEventListener('blur', off);
    view.box.appendChild(row);
  }
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
  // A tab exists because the tier has that map, not because its outline has arrived yet.
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

  // The right-hand column, never over the map: "What happened" on top when
  // there is one (paintMissed), then three tabs over one pane - the
  // scoreboard, the recent captures, and the objective a click picked.
  const side = document.createElement('div');
  side.className = 'wvw-side';

  const paneTabs = document.createElement('div');
  paneTabs.className = 'wvw-subtabs';
  paneTabs.setAttribute('role', 'tablist');
  side.appendChild(paneTabs);

  const pane = document.createElement('div');
  pane.className = 'wvw-pane';
  side.appendChild(pane);

  const board = document.createElement('div');
  board.className = 'wvw-board';
  board.hidden = true;
  pane.appendChild(board);

  const caps = document.createElement('div');
  caps.className = 'wvw-caps';
  pane.appendChild(caps);

  const detail = document.createElement('div');
  detail.className = 'wvw-detail';
  pane.appendChild(detail);

  const paneTab = new Map();
  for (const [key, text, tip] of [
    ['board', 'Board', 'Objectives held and points per tick, every map added up'],
    ['captures', 'Captures', 'Camps, towers, keeps and castles taken in the 30 minutes up to the newest capture'],
    ['objective', 'Objective', 'The objective picked on the map'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wvw-subtab';
    b.dataset.pane = key;
    b.textContent = text;
    b.title = tip;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', (e) => { e.stopPropagation(); showPane(key); });
    paneTabs.appendChild(b);
    paneTab.set(key, b);
  }

  // What the detail panel is showing, so the refresh can repaint it.
  // Cleared with the panel, because a point belongs to the stage that
  // drew it and switching tabs throws that stage away.
  let selected = null;

  const emptyDetail = () => {
    selected = null;
    detail.textContent = '';
    const p = document.createElement('p');
    p.className = 'wvw-detail-empty';
    // Both lists are named because the game names them apart and a defender treats them apart: the tier
    // arrives on its own, the lists under it are what the holding guild chose to install.
    p.textContent = 'Click an objective to see who holds it, how long they have had it, and its tactics and improvements.';
    detail.appendChild(p);
  };

  let current = null;
  let plotWrap = null;

  // ---- the focus (focusMatches): the board's pick, and a spotlight that
  // stands in for it a moment (a chip pointed at). The pick outlives a tab
  // change; a spotlight belongs to the map it was lit on.
  let focusPick = null;
  let focusSpot = null;     // { spec, el }: el, when given, holds it
  let focusTimer = 0;
  // How many objectives a spec lights on each map, by the same focusMatches
  // and the same owners the markers use, over the newest body.
  const focusCounts = (spec) => {
    const n = new Map();
    const live = matchIsLive(liveMatch);
    for (const type of available) {
      const data = (liveMatch.maps || []).find((m) => m.type === type) || byType.get(type);
      const held = new Map(((live && data && data.objectives) || []).map((o) => [o.id, o]));
      let c = 0;
      for (const meta of catalogue.values()) {
        if (!data || meta.map_id !== data.id || MAP_SKIP_TYPES.has(meta.type)) continue;
        const ob = held.get(meta.id);
        if (focusMatches(spec, meta.id, String((ob && ob.owner) || 'neutral').toLowerCase(), meta.type)) c++;
      }
      n.set(type, c);
    }
    return n;
  };
  const sumOf = (n) => [...n.values()].reduce((a, b) => a + b, 0);
  // Set by a click that sent the view to another map while more maps had some:
  // the board's note then says where the rest are (paintFocusNote).
  let focusAlso = false;
  const focusLive = document.createElement('span');
  focusLive.className = 'sr-only';
  focusLive.setAttribute('role', 'status');
  popover.appendChild(focusLive);
  const paintFocusNote = () => {
    const old = board.querySelector('.wvw-focus-note');
    const head = board.querySelector('.wvw-board-head');
    let parts = null;   // [text] or [type, count] pairs
    if (head && focusPick && !focusSpot) {
      const n = focusCounts(focusPick);
      if (!sumOf(n)) parts = ['None on any map right now'];
      else if (focusAlso) {
        const others = available.filter((t) => t !== current && n.get(t) > 0);
        if (others.length) parts = others.map((t) => [t, n.get(t)]);
      }
    }
    const key = JSON.stringify(parts);
    if (!parts) { if (old) old.remove(); return; }
    if (old && old.dataset.key === key) return;
    if (old) old.remove();
    const note = document.createElement('div');
    note.className = 'wvw-focus-note';
    note.dataset.key = key;
    if (typeof parts[0] === 'string') note.textContent = parts[0];
    else {
      note.append('also ');
      parts.forEach(([t, c], i) => {
        if (i) note.append(', ');
        note.append(`${c} on `);
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'wvw-focus-go';
        go.textContent = MAP_TAB_NAME[t] || t;
        go.title = `Show ${MAP_PANEL_NAME[t] || t}`;
        go.addEventListener('click', (e) => { e.stopPropagation(); show(t); });
        note.appendChild(go);
      });
    }
    head.after(note);
  };
  const paintFocus = () => {
    if (activeTrigger !== triggerEl) return;
    // A chip rebuilt under the pointer never says it was left.
    if (focusSpot && focusSpot.el && !focusSpot.el.isConnected) focusSpot = null;
    if (plotWrap) {
      // A pick that nothing holds on any map darkens nothing.
      const empty = !focusSpot && !!focusPick && !sumOf(focusCounts(focusPick));
      plotWrap.paintFocus(empty ? null : focusSpot ? focusSpot.spec : focusPick);
      // The bar over the map follows the picked team (css/maps.css).
      if (focusPick && focusPick.color) plotWrap.dataset.focusTeam = focusPick.color;
      else delete plotWrap.dataset.focusTeam;
    }
    paintBoardFocus(board, focusPick, () => pickFocus(null));
    paintFocusNote();
  };
  // fromClick: the board was clicked. Then a pick with nothing on the map in
  // view goes to the map that has the most (a tie: tab order), and only then -
  // never on a refresh.
  const pickFocus = (spec, fromClick) => {
    clearTimeout(focusTimer);
    focusPick = spec;
    focusSpot = null;
    focusAlso = false;
    focusLive.textContent = '';
    let moveTo = null;
    if (spec && fromClick) {
      const n = focusCounts(spec);
      if (!n.get(current)) {
        const have = available.filter((t) => n.get(t) > 0);
        moveTo = have.reduce((best, t) => (!best || n.get(t) > n.get(best) ? t : best), null);
        focusAlso = have.length > 1;
      }
      const words = focusWords(spec);
      if (moveTo) focusLive.textContent = `${words}: showing ${MAP_PANEL_NAME[moveTo] || moveTo}`;
      else if (!sumOf(n)) focusLive.textContent = `${words}: none on any map right now`;
    }
    if (moveTo) show(moveTo);
    paintFocus();
  };
  // spotlight({ ids } or { color, type }, { map, el, ms }): lit only on
  // that map's tab, for as long as el is pointed at, or for ms. A null
  // spec puts the pick back - only el's own spotlight, when el is given.
  const spotlight = (spec, opts = {}) => {
    if (!spec && opts.el && (!focusSpot || focusSpot.el !== opts.el)) return;
    if (spec && opts.map && opts.map !== current) return;
    clearTimeout(focusTimer);
    focusSpot = spec ? { spec, el: opts.el || null } : null;
    if (spec && opts.ms) focusTimer = setTimeout(() => { focusSpot = null; paintFocus(); }, opts.ms);
    paintFocus();
  };
  // What the board picks: a row is the team, a cell the team and the type,
  // a column header the type. The same one again lets go.
  const pickFromBoard = (target) => {
    const el = target.closest('[data-focus-color], [data-focus-type]');
    if (!el || !board.contains(el)) return false;
    const spec = { color: el.dataset.focusColor || null, type: el.dataset.focusType || null };
    const same = !!focusPick && focusPick.color === spec.color && focusPick.type === spec.type;
    pickFocus(same ? null : spec, true);
    return true;
  };
  board.addEventListener('click', (e) => { if (pickFromBoard(e.target)) e.stopPropagation(); });
  board.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.target.getAttribute('role') !== 'button') return;
    e.preventDefault();
    pickFromBoard(e.target);
  });
  // A tap anywhere else in the popover lets go - not one on the board or a
  // marker, and not the end of a drag across the map.
  let downAt = null;
  popover.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; }, true);
  popover.addEventListener('click', (e) => {
    if (!focusPick || e.target.closest('.wvw-board, .wvw-marker, .wvw-zoom, .wvw-hud, .wvw-hud-note, .wvw-missed, .wvw-tabs, .wvw-subtabs, .wvw-caps')) return;
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    pickFocus(null);
  });
  mapFocusEscape = () => {
    if (activeTrigger !== triggerEl || !focusPick) return false;
    pickFocus(null);
    return true;
  };
  // paintMapBoard rebuilds the board; a key held on it is put back.
  const boardSpot = (el) => (el.classList.contains('wvw-focus-pill') ? 'pill'
    : `${(el.closest('[data-focus-color]') || el).dataset.focusColor || ''}|${el.dataset.focusType || ''}`
      + `|${el.classList.contains('wvw-board-team')}`);
  const paintBoard = (m, live) => {
    const had = board.contains(document.activeElement) ? boardSpot(document.activeElement) : null;
    paintMapBoard(board, m, live);
    paintFocus();
    if (!had) return;
    const back = [...board.querySelectorAll('[role="button"], .wvw-focus-pill')].find((el) => boardSpot(el) === had);
    if (back) back.focus({ preventScroll: true });
  };

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

  // A pick made from a list (the summary's chips, the captures) leaves the
  // summary as it is: only a click on the map itself folds it.
  let listPick = false;
  const draw = (type, sectors) => {
    focusSpot = null;
    // The freshest body, not the one this popover opened with: that one
    // would put the board back to the opening's numbers on a tab change.
    paintMapBoard(board, liveMatch, matchIsLive(liveMatch));
    stage.textContent = '';
    plotWrap = sectors && sectors.length
      ? buildMapStage(match, byType.get(type), sectors, catalogue, (p, m) => {
        selected = p;
        renderObjectiveDetail(detail, p, m);
        detail.scrollTop = 0;
        if (!listPick) { missedFold(match.id); paintNote(); }
        showPane('objective');
      })
      : null;
    if (plotWrap) {
      // Over the plot, not inside the SVG: the SVG is the camera and
      // everything in it pans and zooms with the terrain.
      const sb = buildScoreBar(byType.get(type), matchIsLive(match));
      if (sb) plotWrap.appendChild(sb);
      corners = buildMapCorners(plotWrap, match.id);
      paintCorners();
      stage.appendChild(plotWrap);
    } else {
      // The outline is the drawing's frame, so without it there is no map; the other tabs are unaffected,
      // which is why this replaces the stage and not the popover.
      const msg = document.createElement('p');
      msg.className = 'hint wvw-stage-msg';
      msg.textContent = "Couldn't load this map right now.";
      stage.appendChild(msg);
    }
    stage.appendChild(side);
    emptyDetail();
    paintNote();
    paintFocus();
  };

  const show = (type) => {
    if (current === type) return;
    current = type;
    for (const b of tabs.children) b.classList.toggle('is-active', b.dataset.type === type);
    const ready = sectorsByType.get(type);
    if (ready) { draw(type, ready); return; }
    // Not here yet: only the tab that opens is waited on, so clicking another early can land ahead of its outline.
    stage.textContent = '';
    const wait = document.createElement('p');
    wait.className = 'hint wvw-stage-msg';
    wait.innerHTML = '<span class="spinner"></span>Loading this map\u2026';
    stage.appendChild(wait);
    pendingSectors.get(type).then((arr) => {
      // The popover can be closed and another tab picked while this is in the air.
      if (activeTrigger !== triggerEl || current !== type) return;
      if (arr && arr.length) sectorsByType.set(type, arr);
      draw(type, arr);
    });
  };

  const tabByType = new Map();

  // What happened while the data was away: paintMissed, for this match. A
  // chip opens its map's tab and selects the objective, as a click on it would.
  missedOpen = { matchId: match.id, trigger: triggerEl };
  const goTo = (type, id, select = true) => {
    show(type);
    if (id == null) return;
    const pick = () => {
      if (activeTrigger !== triggerEl || current !== type || !plotWrap) return;
      if (select) { listPick = true; plotWrap.selectObjective(id); listPick = false; }
      spotlight({ ids: [id] }, { ms: FOCUS_TAP_MS });
    };
    if (sectorsByType.get(type)) pick(); else pendingSectors.get(type).then(pick);
  };
  const paintNote = () => {
    paintMissed({ matchId: match.id, side, tabs: tabByType, type: current, goTo, spot: spotlight, repaint: paintNote });
    paintPane();
    if (plotWrap) plotWrap.ringChanged();
    if (focusSpot && focusSpot.el && !focusSpot.el.isConnected) paintFocus();
  };

  // ---- the pane under the tabs: one box shown, hugging what it holds up to the pane's height, then
  // scrolling. Beside the map the pane ends where the map ends; stacked under it (a phone) the pane has a
  // fixed height, so the map above does not move when the tab changes.
  // The map is measured once per opening (per width and map): measuring on every repaint feeds back, the
  // pane stretching the column, the map with it, then the pane again. The drawing is measured, not its
  // frame, which is the one the column stretches.
  let paneOn = 'board';
  let paneSize = null;   // { key, at }: the map's bottom (wide) or the pane (stacked)
  const sizePane = () => {
    let h;
    if (window.matchMedia(MAP_STACKED).matches) {
      const key = `stacked ${window.innerWidth}`;
      if (!paneSize || paneSize.key !== key || paneSize.guess) {
        // From the board's own height, while it shows; a guess until it does.
        const rows = paneOn === 'board' && !board.hidden ? board.offsetHeight : 0;
        paneSize = { key, at: Math.max(rows + PANE_ROOM, PANE_MIN), guess: !rows };
      }
      h = paneSize.at;
    } else {
      const plot = plotWrap && plotWrap.querySelector('.wvw-plot');
      if (!plot) return;
      const top = side.getBoundingClientRect().top;
      // The drawing's width, not the window's: the popover's own size button
      // changes it too. Neither depends on the pane.
      const key = `wide ${Math.round(plot.getBoundingClientRect().width)} ${current}`;
      if (!paneSize || paneSize.key !== key) {
        // The frame's bottom border under the drawing.
        paneSize = { key, at: plot.getBoundingClientRect().bottom - top + 1 };
      }
      // Under the tabs, which move when "What happened" comes or goes.
      const gap = parseFloat(getComputedStyle(side).rowGap) || 0;
      h = Math.max(PANE_FLOOR, Math.floor(paneSize.at - (paneTabs.getBoundingClientRect().bottom - top) - gap));
    }
    if (side.style.getPropertyValue('--pane-h') !== `${h}px`) side.style.setProperty('--pane-h', `${h}px`);
  };
  const paintPane = () => {
    // Nothing picked (a map tab change throws the pick away): back to the board.
    if (paneOn === 'objective' && !selected) paneOn = 'board';
    const items = recentCaptures(liveMatch);
    for (const [key, b] of paneTab) {
      const on = key === paneOn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    paneTab.get('objective').disabled = !selected;
    const label = `Captures (${items.length})`;
    if (paneTab.get('captures').textContent !== label) paneTab.get('captures').textContent = label;
    board.classList.toggle('is-off', paneOn !== 'board');
    caps.classList.toggle('is-off', paneOn !== 'captures');
    detail.classList.toggle('is-off', paneOn !== 'objective');
    paintCaptures({ box: caps, match: liveMatch, goTo, spot: spotlight }, items);
    sizePane();
  };
  const showPane = (key) => {
    if (key === 'objective' && !selected) return;
    paneOn = key;
    paintPane();
  };

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
  // has to read this, or it quietly undoes the opening pull.
  let liveMatch = match;
  let hotFresh = false;

  // One fetch of this tier's match, and everything that has to be
  // repainted when it lands. Called on opening and then on the poll.
  // Stamped when asked, not when answered, so a catch-up and the poll do
  // not both fire for the same gap. The sequence number keeps a slow
  // answer from painting over a newer one that overtook it, unless the older
  // answer is a body of the copy further along (the copy is asked once per gap,
  // so a newer read may not have it).
  let pulledAt = 0;
  let pullSeq = 0;
  let paintedSeq = 0;
  const pullFresh = async () => {
    pulledAt = Date.now();
    const asked = Date.now();
    const seq = ++pullSeq;
    let fresh;
    try {
      // Never behind what this page has already seen: see fetchMatches.
      fresh = await fetchMatches(`${API_BASE}/wvw/matches?id=${encodeURIComponent(match.id)}`);
    } catch {
      // A body further along than the one on show, come while the game's
      // read failed (our copy, late: offerLate), is painted all the same.
      const kept = newestMatches.get(match.id);
      if (kept && matchIsBehind(liveMatch, kept.match)) fresh = kept.match;
    }
    firstReadDone = true;
    if (activeTrigger !== triggerEl || !fresh || !Array.isArray(fresh.maps)) return;
    if (seq < paintedSeq && !(latestBodyAt.has(fresh) && matchIsBehind(liveMatch, fresh))) return;
    paintedSeq = Math.max(paintedSeq, seq);
    for (const m of fresh.maps) if (byType.has(m.type)) byType.set(m.type, m);
    liveMatch = fresh;
    // Outlives the popover, so reopening starts from here.
    freshRecall.data = fresh;
    hotFresh = true;
    recordFightSamples([fresh], asked);
    markHotTab(liveMatch);
    const now = byType.get(current);
    // Asked of the answer that just arrived, not of the match this popover opened with: a tier can turn over
    // while the maps are open.
    const live = matchIsLive(fresh);
    paintBoard(fresh, live);
    if (plotWrap && plotWrap.applyLive && now) plotWrap.applyLive(now, live);
    // The panel was born from a click and then stood still: the marker beside it can change hands, tier or
    // guild meanwhile. applyLive rewrites the point in place, so repainting is all it takes.
    if (selected) renderObjectiveDetail(detail, selected, fresh);
    if (plotWrap) {
      const old = plotWrap.querySelector('.wvw-scorebar');
      const sb = buildScoreBar(now, live);
      if (old) old.remove();
      if (sb) plotWrap.appendChild(sb);
    }
    paintCorners();
    paintNote();
    // A rise after a gap is dated by the history, which this open map has
    // not read since before the gap: once, then killSheetAt passes gapFrom.
    const gapFrom = (newestMatches.get(match.id) || {}).gapFrom;
    if (gapFrom && killSheetAt < gapFrom) {
      getKillSheet().then(() => { if (activeTrigger === triggerEl) { paintCorners(); paintNote(); } });
    }
  };

  // The maps keep themselves current while they are open. The standings refresh cannot: it rebuilds the
  // whole board, and the button this popover is anchored to goes with it. So this asks for one match, not
  // all nine, and repaints in place.
  // Visible is enough, focus is not asked for: the window beside the game is where these maps are read.
  // Only a hidden tab skips the tick, and mapCatchUp pulls the moment it is shown again.
  clearInterval(mapPollTimer);
  mapPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    // A catch-up just ran; this tick would ask again seconds later.
    if (Date.now() - pulledAt < MAP_REFRESH_MS / 2) return;
    pullFresh();
  }, MAP_REFRESH_MS);
  mapCatchUp = () => {
    if (Date.now() - pulledAt >= MAP_REFRESH_MS) pullFresh();
  };
  mapAhead = (ids) => {
    if (document.visibilityState !== 'hidden' && ids.has(match.id)) pullFresh();
  };

  clearInterval(mapTickTimer);
  mapTickTimer = setInterval(() => {
    tickRi(stage);
    // The kills' silence grows by the second as the score's age does: the
    // swords, the badge and the corner are judged again together.
    if (hotMarked) markHotTab(liveMatch); else paintCorners();
    paintNote();
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
  // The swords wait for the fresh reading rather than being painted from the one this popover opened with:
  // that reading can be five minutes old and pick a different map, so painting at once would move the swords
  // a breath later. The tab titles are already set above, so nothing is blank. A fetch that never lands keeps
  // the stale reading, which still beats no swords.
  // Unless the body this page keeps rose within HOT_NOW_MS: that one is as fresh as the read, so the swords
  // and the kills go up at once.
  const keptNow = newestMatches.get(match.id);
  if (keptNow && Date.now() - keptNow.at <= HOT_NOW_MS) {
    liveMatch = keptNow.match;
    markHotTab(liveMatch);
  }
  setTimeout(() => {
    if (activeTrigger === triggerEl && !hotFresh) markHotTab(liveMatch);
  }, 2500);
  // Again when the sheet lands - but only once there is a fresh reading
  // for it to be applied to. It resolves from cache on every later open,
  // so without that guard it would fire straight back over the fresh answer.
  getKillSheet().then(() => {
    if (activeTrigger !== triggerEl) return;
    if (hotFresh) markHotTab(liveMatch);
    else paintCorners(); // the history may have backdated the score time
  });
  show(available[0]);

  // And once, right now, rather than waiting out the first poll.
  // This popover opens with the match the standings panel is holding, and that panel refreshes every five
  // minutes, so a snapshot that old can be missing many of the objectives under it. One request, blocks
  // nothing (the map is already up), and fixes the swords in the same move.
  pullFresh();

  // The other three terrain pictures, once the first map is up, so a tab switch does not start its own
  // download. The lite pictures only: the full ones wait for a zoom that needs them. decode() rather than
  // just src, because the decode runs on the main thread. One at a time, in tab order, so they do not race
  // the pictures the VISIBLE map is still pulling.
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
      // A warm-up that fails is not an error: the tab that needs it asks
      // again. Either way the queue moves on.
      if (im.decode) im.decode().then(next, next);
      else { im.onload = next; im.onerror = next; }
    };
    next();
  };
  // Not for a connection that has asked to be spared: this is megabytes of maps nobody asked to see.
  const conn = navigator.connection;
  if (!conn || !(conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) {
    if (window.requestIdleCallback) requestIdleCallback(warmTerrain, { timeout: 4000 });
    else setTimeout(warmTerrain, 1500);
  }
}

// The rest of a tier's opening, once maps-early.js has opened the popover
// with its spinner and this file has loaded.
async function fillTierMaps(popover, match, regionName, tierNum, triggerEl) {
  // Reopen with what we already know, not with what the standings panel is holding: a reopen would paint
  // from a snapshot this popover had already bettered, then correct itself a second later.
  // Which of the two is newer is decided by identity, not by clocks: every standings refresh parses fresh
  // JSON, so a match object we have seen before means that panel has not refreshed and ours is newer. A
  // different object means it is ahead of us, and it wins.
  if (freshRecall && freshRecall.from === match) {
    if (freshRecall.data) match = freshRecall.data;
  } else {
    freshRecall = { from: match, data: null };
  }

  const wanted = (match.maps || []).filter((m) => MAP_PANEL_ORDER.includes(m.type));
  const firstType = MAP_PANEL_ORDER.find((t) => wanted.some((m) => m.type === t));
  const firstMap = wanted.find((m) => m.type === firstType);

  // The terrain picture, asked for here rather than by the <image> node, which is built after everything
  // below has resolved and would queue behind the API. Same URL, so the <image> finds it in the cache.
  const firstPic = firstMap && MAP_IMAGE[firstMap.id];
  if (firstPic) { const pre = new Image(); pre.src = firstPic.lite; }

  // Started, never awaited: none of these draws a map. They land while the map is already on screen.
  getUpgradeCatalogue();
  getEmblemPieces();
  // Started here and never awaited: the first tab must not wait on a spreadsheet.
  getKillSheet();
  const tacticIds = [];
  for (const m of match.maps || []) {
    for (const ob of m.objectives || []) {
      if (Array.isArray(ob.guild_upgrades)) tacticIds.push(...ob.guild_upgrades);
    }
  }
  if (tacticIds.length) getTacticCatalogue(tacticIds);

  // All four outlines go out at once, but only the tab that opens is waited on, so an opening is not
  // charged the slowest of them. show() waits on one if you get there first.
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
    if (activePopover !== popover) return;
    popover.textContent = '';
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = "Couldn't load the map data right now.";
    popover.appendChild(msg);
    return;
  }

  // Closed and opened again, the same button holds a new popover.
  if (activePopover !== popover) return;
  renderTierMapsContent(popover, match, regionName, tierNum, catalogue,
    sectorsByType, pendingSectors, triggerEl);
}
