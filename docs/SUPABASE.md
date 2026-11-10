# Sincronización privada de KONTEN

GitHub Pages sigue sirviendo la aplicación. Los registros sincronizados se guardan en el proyecto de Supabase del propietario de KONTEN, asociados a la cuenta con la que cada persona inicia sesión. El proyecto aún debe configurarse antes de activar la sincronización real.

## 1. Crear el proyecto y configurar el acceso

1. Crear un proyecto en el plan adecuado de [Supabase](https://supabase.com/dashboard). Un proyecto del plan gratuito sirve para comenzar, sujeto a sus límites vigentes.
2. En **Authentication → URL Configuration**, usar `https://brenrojarq.github.io/account/` como **Site URL** y añadir esa misma URL a las redirecciones permitidas. Si se usa otro dominio, configurarlo también; evitar comodines que permitan redirigir a dominios ajenos.
3. Habilitar el proveedor **Email** y conservar la confirmación de correo. Configurar los límites de envío y SMTP cuando corresponda: el envío compartido de Supabase tiene restricciones y no debe darse por disponible para cualquier destinatario.
4. Copiar **Project URL** y la clave **Publishable** (`sb_publishable_…`) desde el diálogo **Connect** o la configuración de API. Estos dos valores son configuración pública del cliente, no otorgan acceso a las finanzas sin una sesión válida y las políticas del paso siguiente.

La contraseña de la base, las claves **Secret**/`service_role` y los tokens de administración no deben incluirse en el frontend ni en el repositorio. El desarrollo normal de KONTEN requiere únicamente URL y clave pública una vez instalado el esquema.

## 2. Instalar el esquema privado

En el **SQL Editor** del proyecto, revisar y ejecutar el contenido completo de [`202611100001_private_sync.sql`](../supabase/migrations/202611100001_private_sync.sql). El archivo crea únicamente los objetos de KONTEN y termina con `commit`. No modifica importes del navegador ni importa registros automáticamente.

La migración contiene:

- `konten_records`, una fila por ingreso, egreso, meta, presupuesto o preferencias, con propietario, revisión y fecha del servidor.
- RLS: una persona autenticada puede leer sólo filas cuyo `user_id` coincide con su sesión. El rol anónimo no puede leer registros. El navegador no tiene permisos directos de inserción, edición o eliminación.
- `konten_apply_changes`, un RPC que obtiene el propietario de `auth.uid()` y compara revisiones antes de aplicar el lote. Si cualquier fila tiene un conflicto, no escribe ninguna fila de ese lote.
- Marcadores de eliminación, para que un dispositivo desconectado no vuelva a crear accidentalmente un registro que otro dispositivo eliminó.
- Recibos privados de idempotencia: el mismo identificador y contenido de operación producen la misma respuesta, sin aplicar dos veces el cambio. Reutilizar el identificador con otro contenido se rechaza.

No desactivar RLS para resolver un error de configuración. No añadir políticas de acceso público a estas tablas. Las llamadas válidas llevan la clave pública y el JWT de la cuenta autenticada.

## 3. Conectar y comprobar la aplicación

Configurar los dos valores públicos en `cloud-config.json` antes de compilar y publicar:

```json
{
  "url": "https://REFERENCIA-DEL-PROYECTO.supabase.co",
  "publishableKey": "sb_publishable_CLAVE_PUBLICA_DEL_PROYECTO"
}
```

Como alternativa, el proceso de compilación admite `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`; esos valores tienen prioridad sobre el archivo. Ambas opciones se incluyen en el cliente publicado, por lo que sólo se admiten URL y clave **publishable**, nunca credenciales administrativas. Cuando los valores están vacíos o son inválidos, KONTEN conserva su modo local y muestra que la conexión está pendiente. El HTML portátil no activa la conexión de cuenta.

La contraseña que cada persona elige para iniciar sesión pertenece a Supabase Auth y no debe compartirse con quien configura la aplicación.

Antes de trasladar registros existentes, descargar un respaldo completo en cada dispositivo que tenga información propia. La primera vinculación debe mostrar qué datos locales se importan y qué datos ya existen en la nube; un navegador vacío o con ejemplos no debe reemplazar registros reales.

Comprobar con dos cuentas de prueba que ninguna vea los registros de la otra. Con la misma cuenta en celular y computadora, comprobar altas desde ambos, recarga, cambios sin conexión y su posterior sincronización. Un cambio queda pendiente hasta la confirmación del servidor. Dos ediciones incompatibles del mismo registro requieren una resolución visible que conserve el contenido de ambas.

## Contrato del RPC

`konten_apply_changes(p_operation_id uuid, p_changes jsonb)` recibe entre 1 y 500 cambios por operación, hasta 2 MiB por lote. Cada cambio contiene exactamente:

```json
{
  "entity_type": "income",
  "entity_id": "identificador-original",
  "payload": { "id": "identificador-original", "name": "Salario", "amount": 3000, "currency": "USD", "category": "Salario", "date": "2026-11-10", "frequency": "monthly" },
  "deleted": false,
  "expected_revision": 0
}
```

Tipos: `income`, `expense`, `goal`, `budget`, `preferences`. Los identificadores tienen hasta 200 caracteres; `budget` y `preferences` usan exclusivamente el identificador `main`. Cada contenido es un objeto de hasta 64 KiB. Los importes son números no negativos de hasta `10^15`. Para eliminar se envía `deleted: true` y `payload: null`, conservando la revisión que se leyó. Una fila nueva espera revisión 0.

Éxito: `{ "applied": true, "rows": [...], "conflicts": [] }`. Conflicto: `{ "applied": false, "rows": [], "conflicts": [...] }`, sin escrituras parciales. Las filas reales tienen una revisión positiva. Si se esperaba una fila que ya no existe, el conflicto incluye su identificador con revisión 0, `deleted: true`, `payload: null` y `updated_at: null`.

Los recibos se conservan sin caducidad automática. No truncar `konten_sync_receipts` mientras pueda haber dispositivos con operaciones pendientes: hacerlo elimina la garantía de reintento idempotente para esas operaciones. La eliminación administrativa de una cuenta en Supabase elimina sus filas y recibos por relación de propietario.

## Pruebas aisladas del SQL

[`supabase/tests/private_sync.mjs`](../supabase/tests/private_sync.mjs) ejecuta la migración en PostgreSQL embebido con PGlite y cuentas ficticias. No se conecta al proyecto real ni instala su simulación de `auth` en Supabase. Permite comprobar permisos, RLS, revisiones, lotes completos, recibos, eliminaciones y preservación de importes/tasas.

La dependencia de validación está incluida en desarrollo. Después de `npm ci`, ejecutar:

```sh
npm run test:sql
```

Estas pruebas no sustituyen la comprobación final con el proyecto real, la configuración de correo y dos sesiones independientes. La prueba de revisión obsoleta reproduce los resultados de dos dispositivos; PGlite usa una conexión y no prueba planificación simultánea entre procesos del servidor.
