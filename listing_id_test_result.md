# Resultado: ¿qué se puede obtener con `listing_id` vía ML API?

**TL;DR**: Con nuestras credenciales `client_credentials` actuales, **NO**.
ML bloquea el endpoint `/items/{id}` para apps de terceros — solo el seller
dueño del item puede leerlo. La única vía viable para enriquecer datos de
listing es scrapear el HTML de la página del listing (vía Bright Data, igual
que hacemos hoy para el catálogo).

---

## Intento 1 — Endpoint público sin auth

```bash
GET https://api.mercadolibre.com/items/MLC3221953898
```

**Respuesta**: `HTTP 403`
```json
{
  "message": "Access to the requested resource is forbidden",
  "error": "access_denied",
  "status": 403,
  "cause": null
}
```

## Intento 2 — Con OAuth2 client_credentials

Token obtenido OK (74 chars, `Bearer ...`), pero mismo bloqueo:

```bash
GET https://api.mercadolibre.com/items/MLC3221953898
Authorization: Bearer <token>
```

**Respuesta**: `HTTP 403` — `access_denied`

## Intento 3 — Variante multi-get

```bash
GET https://api.mercadolibre.com/items?ids=MLC3221953898
Authorization: Bearer <token>
```

**Respuesta**: `HTTP 200` (la envoltura es 200) pero cada item viene con `403`:
```json
[
  {
    "code": 403,
    "body": {
      "id": "MLC3221953898",
      "message": "Access to the requested resource is forbidden",
      "error": "access_denied",
      "status": 403,
      "cause": null
    }
  }
]
```

## Intento 4 — Multi-get con `attributes` whitelist

Probé pidiendo solo campos públicos (`id,title,price,seller_id,condition,
official_store_id,shipping,sold_quantity,available_quantity,permalink`).
Mismo resultado: `403 access_denied` por item.

---

## Por qué pasa

MercadoLibre cerró el acceso "público" a `/items/{id}` para terceros con
`client_credentials`. Hoy ese endpoint requiere:

1. **OAuth2 `authorization_code`** del seller dueño del item (imposible para
   análisis de terceros — necesitaríamos que cada vendedor nos autorice), o
2. Una **alianza marketplace partner** con ML (no es un trámite normal).

Esto es la misma restricción documentada en [CLAUDE.md](CLAUDE.md) para
`/sites/{siteId}/search`. ML los blindó alrededor de 2022-2023 para frenar
scraping vía API.

---

## Qué SÍ funciona con `client_credentials` (lo que ya usamos)

| Endpoint | Para qué |
|---|---|
| `GET /sites` | Listado de países |
| `GET /sites/{siteId}/categories` | Categorías raíz de un país |
| `GET /categories/{id}` | Detalle de una categoría (incluye hoja) |
| `GET /products/{catalog_id}` | Detalle del catálogo (no del listing) |

---

## Workaround: scrapear la URL del listing

La URL pública del listing **sí** se puede scrapear (igual que la página del
catálogo). Hay **dos formatos válidos** comprobados (HTTP 200 con UA de browser):

**Formato A — subdominio `articulo.` + sufijo `_JM`** (el slug es decorativo):
```
https://articulo.mercadolibre.cl/MLC-3221953898-_JM                ✅ HTTP 200
https://articulo.mercadolibre.cl/MLC-3221953898-cualquier-cosa-_JM ✅ HTTP 200
https://www.mercadolibre.cl/MLC-3221953898                         ❌ HTTP 404
https://www.mercadolibre.cl/MLC-3221953898-_JM                     ❌ HTTP 404
```
Estructura: `https://articulo.{dominio-país}/MLC-{numero}-{slug-opcional}-_JM`.
El sufijo `_JM` es obligatorio; el slug intermedio puede ser cualquier cosa
o ausente.

**Formato B — catálogo + query `wid`** (preferido cuando se tiene `catalog_id`):
```
https://www.mercadolibre.cl/p/MLC47591525?wid=MLC3221953898        ✅ HTTP 200
```
ML te muestra la página del catálogo destacando el listing pasado en `wid`.

De la página HTML se podrían extraer:
- `seller_id`, nickname del vendedor
- `official_store_id` (si aparece "Tienda oficial XXX")
- `condition` (nuevo/usado)
- `available_quantity` (a veces se renderiza, a veces no)
- `shipping` (envío gratis, ML Full, etc.)
- Atributos / variantes
- Imágenes

**Costo**: 1 navegación Bright Data extra por producto = +20 navegaciones por
categoría. Hoy hacemos 21 navegaciones/categoría (1 categoría + 20 productos);
pasaríamos a 41/categoría, casi 2× el costo de bandwidth (~$50/sync en vez de
~$26).

**Alternativa más barata**: scrapear el listing solo para los productos
**sin `catalog_id`** (los `/up/` URLs que hoy quedan vacíos de enriquecimiento).
Esos son ~10-15% del total y necesitan datos en algún lado.

---

## Conclusión

- `listing_id` sirve hoy solo para:
  1. **Reconstruir la URL pública** (útil para reportes / linkear desde un dashboard).
  2. **Deduplicación**: detectar si el mismo listing aparece en el ranking
     semana tras semana.
  3. **Eventual scraping futuro** si decidimos enriquecer con datos del vendedor.

- No abre puertas adicionales vía API mientras usemos `client_credentials`.
