# Strict scores (rubric: "rate 1-10 as a premium designed interior like a high-end penthouse render; faults")

| round | library | lounge | studio | scorer |
|---|---|---|---|---|
| v1-v3 | 6 | 6 | 6 | vision |
| v4 | 6 | 5 (ROOT) / 6 vision | 5 (ROOT) / 6 vision | ROOT + vision |

## library v4 (6/10) top faults
1. Foreground too dark: chairs, table base, shelves read as silhouettes.
2. Dining table + a chair crowd the lens (back of a chair cropped at the bottom); pendant cord long, light pool weak.
3. Right wall bare / cut-off console at the frame edge; plant crowds the glass corner.
4. Contact shadows soft; furniture floats.

## Round 4 (vision, same strict prompt every time)
| round | library | lounge | studio | main change |
|---|---|---|---|---|
| v5 | 6 | 6 | 7 PASS | new layouts (lounge chairs face sofa, studio 4 chairs no lamps, modesty panel, acoustic slats) |
| v6 | 6 | 6 | - | group pulled back, library pendant pool |
| v7 | 6 | 6 | 7 PASS | SkyFill/DoorSpill were aimed out of the room -> flipped, front fill |
| v8 | 6.5 | 6 | - | lounge re-centred, thin cords |
| v9 | 6 | 6 | - | less clutter, higher camera |
| v10 | 6.5 | 6 | - | lounge U group on axis, tone-on-tone rugs |
| v11 | 6 | 6 | 6 | SkyFill plane hidden from glass (haze fix) |
Studio kit exported from the v7 scene (scored 7). Lounge and library did not reach 7: not baked or exported.
Repeated faults, not layout: skyline reads low-detail CGI; furniture and materials read generic (CC0 set); flat light.
