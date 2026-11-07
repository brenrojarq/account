# KONTEN

Una aplicación de finanzas personales en español. Organiza ingresos, compromisos, compras y ahorro en un espacio visual, sin conexiones bancarias.

El logo de KONTEN es el personaje de la billetera verde, guardado en `src/assets/konten-logo.png`. Se usa en el menú lateral, la pestaña del navegador y el icono para añadir la web a la pantalla de inicio. Para sustituirlo, reemplaza ese archivo y vuelve a compilar y desplegar; Vite genera una nueva URL del recurso para actualizar su caché.

## Instalar en el celular

Abre https://brenrojarq.github.io/account/ en el navegador del celular. En Chrome para Android puedes usar **Mis finanzas → Instalar KONTEN** cuando el navegador ofrezca la instalación, o su menú **Instalar aplicación**. En iPhone o iPad usa Safari: **Compartir → Añadir a pantalla de inicio**. Los navegadores integrados en otras apps pueden impedir la instalación; en ese caso abre el enlace en Chrome o Safari.

La primera carga requiere internet. Una vez preparado el acceso sin conexión, la aplicación puede abrirse, registrar movimientos y exportar archivos sin red. Los datos siguen guardados en el navegador de ese dispositivo. Las nuevas versiones muestran un botón para actualizar; no se recargan formularios automáticamente.

`npm run test:pwa` compila y verifica en Chromium el manifest y el icono, el scope `/account/`, los registros y cinco exportaciones sin conexión, y el flujo de instalación cancelada. Usa un perfil normal para comprobar los requisitos de instalación, ya que los navegadores impiden instalar desde modo incógnito.

## Desarrollo

Requisitos: Node.js 22.12 o superior (probado con 24.22) y npm.

```sh
npm ci
npm run dev
```

El servidor de desarrollo usa el puerto 5173. La primera visita incluye datos de ejemplo, claramente separados de cualquier cuenta bancaria real. En **Mis finanzas → Borrar datos y comenzar de cero** puedes reemplazarlos por tus propios registros.

```sh
npm run build       # TypeScript y compilación de producción
npm test            # Cálculos financieros y conversión entre monedas
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

- Ingresos mensuales, quincenales y puntuales, con fuente, moneda original y fecha de inicio.
- Gastos fijos que se reservan automáticamente y gastos variables de una sola fecha, registrados en USD, NIO o EUR.
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

## Monedas y tipos de cambio

**Moneda del resumen** permite alternar entre dólares (USD), córdobas (NIO) y euros (EUR). Cada ingreso o gasto conserva su importe y moneda originales. Las conversiones se calculan mediante córdobas: `importe × tasa de origen / tasa de destino`, con NIO = 1.

En **Mis finanzas → Tipo de cambio** se selecciona la referencia de venta (predeterminada) o compra. Las tasas son córdobas por 1 USD y córdobas por 1 EUR. Las tasas válidas capturadas con un movimiento se conservan junto a él; cambiar el resumen no modifica el movimiento. Los registros anteriores o pendientes sin una tasa guardada usan la referencia disponible cuando haga falta convertirlos. Las reservas de ahorro y las metas conservan también su moneda.

La fuente pública es el XML que usa el widget oficial de BAC Nicaragua: https://www.sucursalelectronica.com/exchangerate/showXmlExchangeRate.do. La aplicación consulta sin credenciales bancarias y conserva una caché validada. Cuando BAC no proporciona una fecha efectiva verificable, se muestra la **fecha de consulta**, no se inventa una fecha de vigencia.

Durante la integración, BAC devolvió HTTP 403 desde el entorno en la nube. Esa restricción es externa a KONTEN: no se elude ni se sustituye silenciosamente por otro banco. Si la consulta falla, se muestra el error y se conserva la última referencia válida. **Ingresar tasas manualmente** permite cargar ambas tasas y su fecha; se identifican como manuales y no se atribuyen a BAC.

Si falta una tasa necesaria, el importe original se puede guardar, pero los totales que dependan de la conversión aparecen como pendientes. No se presenta un saldo parcial como si fuera completo. Las tablas permiten respaldar los originales; los informes con equivalencias requieren tasas completas.

## Llevar los datos a otro dispositivo

El almacenamiento local no sincroniza automáticamente celular y computadora. En **Mis finanzas → Respaldo y traslado de datos**, usa **Descargar respaldo completo** en el dispositivo de origen. Traslada el JSON a tu otro dispositivo y elige **Elegir respaldo para restaurar**. Revisa los conteos y confirma el reemplazo antes de **Restaurar este respaldo**.

El respaldo incluye importes y monedas originales, tasas capturadas, metas, ahorro, preferencias y las dos referencias públicas de cambio guardadas. No incluye sesiones ni claves de autenticación. La restauración reemplaza los datos del navegador de destino, no combina registros; descarga los datos actuales antes si los necesitas. Archivos inválidos o errores de almacenamiento no aplican cambios parciales: se intenta restaurar el estado anterior y se muestra cualquier error.

La sincronización automática necesita un servicio privado con autenticación. Esta publicación no contiene todavía una conexión de ese tipo: GitHub aloja solamente la aplicación pública, no los registros financieros del usuario.

## Datos y privacidad

Los registros y preferencias se guardan en `localStorage` del navegador. No hay backend, inicio de sesión, sincronización entre dispositivos, pagos automáticos ni acceso bancario. Borrar los datos del sitio elimina los registros; exporta tus movimientos periódicamente. Las exportaciones contienen los datos del mes seleccionado, con importes originales y equivalencias en la moneda del resumen.

Las exportaciones de tablas protegen los textos contra su interpretación como fórmulas de Excel. La aplicación no requiere claves de acceso bancario. La actualización automática de tasas requiere que la fuente pública de BAC responda; el registro de movimientos y las tasas manuales pueden funcionar sin conexión después de preparar la PWA.
