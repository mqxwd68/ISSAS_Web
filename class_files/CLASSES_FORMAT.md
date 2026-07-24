# ISSAS class-file format

Import via **Setup → Classes → Choose on server… / Upload JSON/YAML…**.
The file defines the class **names** and their integer **IDs**. The ID is the value
written into the palette PNG for that class, so it must be **1–255** and unique.
**0 is reserved for background** and must not be used as a class ID.

The parser accepts several shapes — pick whichever is convenient. All work in both
`.json` and `.yaml`/`.yml`.

---

## 1. Grouped (recommended for surgical scenes)

Splits classes into `tissue` and `instrument`, which the Add-object picker shows as
"Tissue & organs" and "Instruments". IDs are taken from the values.

```json
{
  "tissue":     { "Liver": 10, "Pancreas": 8 },
  "instrument": { "Grasper": 13 }
}
```

## 2. Flat map  `{ name: id }`

One dict, explicit IDs. All classes appear under a single group in the picker.

```json
{ "Grasper": 1, "Liver": 2, "Fat": 3 }
```

## 3. List of names  `[ name, ... ]`

Simplest form — IDs are assigned automatically as 1, 2, 3, … in order.

```yaml
- Tool
- Tissue
```

## 4. List of objects  `[ { name, id }, ... ]`

Explicit IDs via a list (useful when order matters or IDs are sparse).

```json
[ { "name": "Grasper", "id": 6 }, { "name": "Liver", "id": 10 } ]
```

## 5. Wrapped  `{ "classes": ... }`

Any of the above under a `classes` key (dict or list).

```json
{ "classes": { "Grasper": 1, "Liver": 2 } }
```

---

## Notes

- **IDs**: integers 1–255, unique. Gaps are fine (e.g. Gastro28 skips some numbers).
- **Grouping is optional.** Ungrouped files (shapes 2–5) list every class together;
  only the grouped shape (1) gets the tissue/instrument split in the picker.
- **Changing the class file resets the current annotations** (objects, masks, SAM-raw).
- **Colors** are derived automatically from each class ID, so you don't set them.
- The default built-in set is **Gastro28** (`gastro28.json` / `gastro28.yaml`); use
  **Reset to default** to return to it.

## Example files in this folder

| File | Task | Shape |
|---|---|---|
| `gastro28.json` / `gastro28.yaml` | Gastro28 (the built-in default) | grouped |
| `example_cholecseg8k.json` | Laparoscopic cholecystectomy | flat map |
| `example_endoscopy_list.yaml` | GI endoscopy (tiny) | list of names |
