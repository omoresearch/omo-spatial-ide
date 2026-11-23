# ASSETS — lane cc0-assets

All third-party assets come from Poly Haven (https://polyhaven.com). Licence: CC0 1.0 Universal (public domain), see https://polyhaven.com/license. Downloaded through the public API (api.polyhaven.com/files/<id>) by `fetch_assets.py`. No login, no key, no cost.

## HDRI (backdrop + image-based lighting)

| Asset | File | Source | Licence |
|---|---|---|---|
| sunset_jhbcentral (2k) | `assets/hdri/sunset_jhbcentral_2k.hdr` | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/sunset_jhbcentral_2k.hdr (page: https://polyhaven.com/a/sunset_jhbcentral; photo Dimitrios Savva, processing Greg Zaal) | CC0 |
| sunset_jhbcentral (8k) | `assets/hdri/sunset_jhbcentral_8k.hdr` | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/8k/sunset_jhbcentral_8k.hdr (page: https://polyhaven.com/a/sunset_jhbcentral; photo Dimitrios Savva, processing Greg Zaal) | CC0 |

Note: Poly Haven has no New York HDRI. `sunset_jhbcentral` (central Johannesburg rooftop at sunset) is the best elevated city-at-dusk option in the catalogue (checked all 61 night HDRIs plus every skyline/rooftop tag). The view out of the glass is Johannesburg, not Manhattan.

## glTF models (1k textures)

| Model | Used in scene | Source | Licence |
|---|---|---|---|
| metal_office_desk | yes | https://polyhaven.com/a/metal_office_desk | CC0 |
| modern_arm_chair_01 | yes | https://polyhaven.com/a/modern_arm_chair_01 | CC0 |
| sofa_02 | yes | https://polyhaven.com/a/sofa_02 | CC0 |
| mid_century_lounge_chair | yes | https://polyhaven.com/a/mid_century_lounge_chair | CC0 |
| modern_coffee_table_01 | yes | https://polyhaven.com/a/modern_coffee_table_01 | CC0 |
| side_table_01 | yes | https://polyhaven.com/a/side_table_01 | CC0 |
| modern_ceiling_lamp_01 | yes | https://polyhaven.com/a/modern_ceiling_lamp_01 | CC0 |
| potted_plant_04 | yes | https://polyhaven.com/a/potted_plant_04 | CC0 |
| calathea_orbifolia_01 | yes | https://polyhaven.com/a/calathea_orbifolia_01 | CC0 |
| potted_plant_02 | yes | https://polyhaven.com/a/potted_plant_02 | CC0 |
| pachira_aquatica_01 | yes | https://polyhaven.com/a/pachira_aquatica_01 | CC0 |
| modern_wooden_cabinet | yes | https://polyhaven.com/a/modern_wooden_cabinet | CC0 |
| ceramic_vase_01 | yes | https://polyhaven.com/a/ceramic_vase_01 | CC0 |
| Ottoman_01 | yes | https://polyhaven.com/a/Ottoman_01 | CC0 |
| desk_lamp_arm_01 | yes | https://polyhaven.com/a/desk_lamp_arm_01 | CC0 |
| potted_plant_01 | yes | https://polyhaven.com/a/potted_plant_01 | CC0 |
| steel_frame_shelves_03 | yes | https://polyhaven.com/a/steel_frame_shelves_03 | CC0 |
| hanging_picture_frame_02 | yes | https://polyhaven.com/a/hanging_picture_frame_02 | CC0 |
| standing_picture_frame_01 | yes | https://polyhaven.com/a/standing_picture_frame_01 | CC0 |
| book_encyclopedia_set_01 | yes | https://polyhaven.com/a/book_encyclopedia_set_01 | CC0 |
| brass_vase_01 | yes | https://polyhaven.com/a/brass_vase_01 | CC0 |
| round_wooden_table_01 | yes | https://polyhaven.com/a/round_wooden_table_01 | CC0 |
| dining_chair_02 | yes | https://polyhaven.com/a/dining_chair_02 | CC0 |
| bar_chair_round_01 | yes | https://polyhaven.com/a/bar_chair_round_01 | CC0 |
| coffee_table_round_01 | downloaded, not used | https://polyhaven.com/a/coffee_table_round_01 | CC0 |

## PBR textures (1k JPG: diffuse, normal GL, ARM)

| Texture | Use | Source | Licence |
|---|---|---|---|
| herringbone_parquet | floor | https://polyhaven.com/a/herringbone_parquet | CC0 |
| marble_01 | kitchen island | https://polyhaven.com/a/marble_01 | CC0 |
| white_plaster_02 | walls, ceiling, columns | https://polyhaven.com/a/white_plaster_02 | CC0 |
| wool_boucle | rugs | https://polyhaven.com/a/wool_boucle | CC0 |
| grey_cartago_01 | stone core wall, exterior slab | https://polyhaven.com/a/grey_cartago_01 | CC0 |
| walnut_veneer | desk tops | https://polyhaven.com/a/walnut_veneer | CC0 |

## Made in code (no external asset)

- Room shell, glass, mullions, desk legs and tops (box geometry), monitors, keyboards, plant pot for the calathea.
- Terminal screens: CanvasTexture with monospace text drawn at runtime.
- three.js r180 (MIT) is served by the harness at /three/; no other library.
