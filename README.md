# KONTEN

Una aplicación de finanzas personales en español. Organiza ingresos, compromisos, compras y ahorro en un espacio visual, sin conexiones bancarias.

El logo de KONTEN es el personaje de la billetera verde, guardado en `src/assets/konten-logo.png`. Se usa en el menú lateral, la pestaña del navegador y el icono para añadir la web a la pantalla de inicio. Para sustituirlo, reemplaza ese archivo y vuelve a compilar y desplegar; Vite genera una nueva URL del recurso para actualizar su caché.

## Desarrollo

Requisitos: Node.js 22.12 o superior (probado con 24.22) y npm.

```sh
npm ci
npm run dev
```

El servidor de desarrollo usa el puerto 5173. La primera visita incluye datos de ejemplo, claramente separados de cualquier cuenta bancaria real. En **Mis finanzas → Borrar datos y comenzar de cero** puedes reemplazarlos por tus propios registros.

```sh
npm run build       # TypeScript y compilación de producción
npm test            # 10 pruebas de cálculos financieros
npm run test:e2e    # Flujos y exportaciones con Playwright
npm run preview     # Servir la compilación de producción
```

Las pruebas E2E usan `/usr/bin/chromium` si existe; en otro entorno ejecuta `npx playwright install chromium` primero. Playwright inicia el servidor si no está ejecutándose.

## Abrir desde el celular

El servidor interno del entorno de desarrollo no tiene un enlace público. Para acceder desde otro dispositivo hay que publicar la compilación en un alojamiento HTTPS. Publicar el entorno de Codex y publicar esta web son operaciones diferentes.

La aplicación está preparada para GitHub Pages: sube el proyecto al repositorio, selecciona **GitHub Actions** como fuente en **Settings → Pages** y ejecuta manualmente **Publicar KONTEN en GitHub Pages** desde Actions. El workflow no se ejecuta al guardar ni al hacer push. GitHub mostrará el enlace cuando termine el despliegue; la disponibilidad de Pages en repositorios privados depende del plan y permisos de la cuenta.

También puedes subir el contenido de `dist/` a un alojamiento estático. Las rutas relativas funcionan tanto en un dominio propio como bajo un subdirectorio.

Para generar una entrega de un solo archivo, ejecuta `npm run build:portable`: crea `downloads/KONTEN.html` con JavaScript, estilos, tipografías y exportadores incluidos. Ese archivo puede publicarse como `index.html` en un alojamiento estático. El uso directo con `file://` depende de la política del navegador y no sustituye una web HTTPS para el celular.

## Funciones

- Ingresos mensuales, quincenales y puntuales, con fuente y fecha de inicio.
- Gastos fijos que se reservan automáticamente y gastos variables de una sola fecha.
- Categorías de vivienda, alimentación, transporte, educación, ocio, viajes, trabajo, salud y otros. Usa el concepto para distinguir, por ejemplo, universidad y maestría.
- Ahorro mensual opcional y metas con progreso y aportes sugeridos.
- Dashboard con selección y orden de tarjetas, secciones opcionales y gráficas de pastel, barras o puntos. También permite ver solo gastos recurrentes.
- Filtros, búsqueda, edición y eliminación de movimientos, navegación mensual y tendencia de seis meses.
- Excel y CSV con importes por pago y totales mensuales; informes PDF y Word; captura PNG del dashboard.
- Interfaz adaptable a móvil, navegación por teclado, diálogos con control de foco y tipografías locales.

## Cómo se calcula

`Disponible = ingresos − gastos fijos − gastos variables − ahorro reservado`.

«Quincenal» significa **dos pagos por mes calendario**, no uno cada catorce días. El monto introducido es por pago. Las recurrencias cuentan desde el mes de inicio, incluyendo el mes completo; no se prorratea el primer mes. Los ingresos puntuales y los gastos variables solo cuentan en el mes de su fecha.

Las recurrencias son reglas de presupuesto, no un libro contable bancario inmutable: editar o eliminar una regla recalcula los meses desde su inicio. La reserva de ahorro es una regla mensual global y cambiarla también recalcula los informes anteriores. Los saldos de las metas se actualizan manualmente y no se descuentan de nuevo del disponible.

## Datos y privacidad

Los registros y preferencias se guardan en `localStorage` del navegador. No hay backend, inicio de sesión, sincronización entre dispositivos, pagos automáticos ni acceso bancario. Borrar los datos del sitio elimina los registros; exporta tus movimientos periódicamente. Las exportaciones contienen los datos del mes seleccionado. Cambiar la moneda cambia su presentación, **no convierte importes**.

Las exportaciones de tablas protegen los textos contra su interpretación como fórmulas de Excel. La aplicación no requiere claves ni servicios externos para su funcionamiento habitual.
