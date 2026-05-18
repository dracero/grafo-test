# Limpiar Base de Datos

## Desde el Frontend (Interfaz Web)

1. Abre la aplicación en tu navegador: `http://localhost:3000`
2. En la barra superior derecha, haz clic en el botón **"Limpiar BD"** (ícono de papelera, color rojo)
3. Confirma la acción en el diálogo de confirmación
4. La base de datos será completamente limpiada y la visualización se actualizará automáticamente

## Desde la Línea de Comandos

Ejecuta el siguiente comando en la terminal:

```bash
npm run db:clear
```

Este script eliminará:
- ✅ Todos los nodos
- ✅ Todas las relaciones
- ✅ Todos los constraints
- ✅ Todos los índices (excepto los built-in de Neo4j)

## API Endpoint

También puedes limpiar la base de datos mediante una petición HTTP:

```bash
curl -X DELETE http://localhost:3000/api/database/clear
```

Respuesta exitosa:
```json
{
  "success": true,
  "data": {
    "deletedNodes": 367,
    "deletedRelationships": 387,
    "deletedConstraints": 7,
    "deletedIndexes": 2,
    "constraintNames": ["entity_name_unique", "..."],
    "indexNames": ["entity_embeddings", "..."]
  }
}
```

## ⚠️ Advertencia

Esta acción **NO se puede deshacer**. Todos los datos serán eliminados permanentemente de la base de datos Neo4j.

Asegúrate de tener un respaldo si necesitas conservar los datos.
