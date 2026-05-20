# Optimización del Servicio de Comparación

## Problema Identificado

El reporte de comparación generaba **resultados repetitivos** cuando había múltiples niveles de una misma competencia (ej: Bienestar digital - Nivel 1 a 5). Cada nivel recibía la misma evidencia y sugerencia, haciendo el reporte muy largo y difícil de leer.

### Ejemplo del Problema:
```
✗ Faltante REQ-028 Bienestar digital - Nivel 1
  Evidencia: El programa no aborda el bienestar digital...
  Sugerencia: Considerar la inclusión de preguntas sobre bienestar digital...

✗ Faltante REQ-029 Bienestar digital - Nivel 2
  Evidencia: El programa no aborda el bienestar digital...
  Sugerencia: Considerar la inclusión de preguntas sobre bienestar digital...

✗ Faltante REQ-030 Bienestar digital - Nivel 3
  Evidencia: El programa no aborda el bienestar digital...
  Sugerencia: Considerar la inclusión de preguntas sobre bienestar digital...
```

## Solución Implementada

### 1. **Agrupación Inteligente en el Prompt**
Se modificó el prompt de comparación para instruir al modelo a:
- Detectar requisitos consecutivos de la misma competencia
- Agruparlos en una sola evaluación
- Usar el ID del primer requisito del grupo
- Mencionar en la evidencia que aplica a todos los niveles

### 2. **Expansión Post-Procesamiento**
Se agregó lógica para:
- Detectar patrones de requisitos relacionados (mismo prefijo de competencia)
- Expandir automáticamente el resultado agrupado a todos los niveles
- Mantener la misma evidencia y sugerencia para todos los niveles del grupo
- Asegurar que todos los requisitos normativos tengan una evaluación

### 3. **Algoritmo de Detección de Grupos**
```typescript
// Detecta requisitos consecutivos (ej: REQ-028 a REQ-032)
// Con la misma categoría y competencia base
const relatedItems = normativeOntology.filter(item => {
  const itemIdNum = parseInt(item.id.replace('REQ-', ''), 10);
  return itemIdNum >= baseIdNum && 
         itemIdNum < baseIdNum + 5 &&
         item.category === baseItem.category &&
         item.requirement.split(':')[0] === baseItem.requirement.split(':')[0];
});
```

## Beneficios

✅ **Reportes más concisos**: Menos repetición de evidencias y sugerencias idénticas
✅ **Mejor legibilidad**: Más fácil identificar áreas de mejora reales
✅ **Mismo nivel de detalle**: Todos los requisitos siguen siendo evaluados
✅ **Procesamiento más eficiente**: Menos tokens consumidos en la respuesta del modelo

## Resultado Esperado

Ahora, en lugar de 5 entradas repetidas, verás:
```
✗ Faltante REQ-028 a REQ-032: Bienestar digital (Niveles 1-5)
  Evidencia: El programa no aborda el bienestar digital en ninguno de sus niveles...
  Sugerencia: Considerar la inclusión de preguntas sobre bienestar digital para todos los niveles de competencia...
```

## Cómo Probar

1. Limpia la base de datos: `npm run db:clear` o usa el botón "Limpiar BD" en el frontend
2. Sube dos documentos en la página de comparación
3. Revisa el reporte generado - debería tener menos repeticiones

## Notas Técnicas

- La agrupación se aplica automáticamente durante el post-procesamiento
- Si el modelo no agrupa correctamente, el código lo hace manualmente
- Todos los requisitos normativos siguen siendo evaluados individualmente en el grafo
- La visualización puede mostrar los resultados agrupados o individuales según la configuración
