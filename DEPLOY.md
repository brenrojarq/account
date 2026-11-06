# Publicar Balance

El sitio es estático. Publicar el entorno de Codex conserva el entorno de desarrollo; la web se publica por separado.

## Validación y privacidad

El proyecto compila y las 10 pruebas financieras pasan. Los archivos versionados contienen código y datos de ejemplo; los registros financieros del usuario se guardan en el navegador. No se deben incluir tokens, archivos de credenciales ni exportaciones personales en los commits.

Para GitHub Pages gratuito, esta cuenta requiere un repositorio público. El usuario autorizó hacer público `brenrojarq/account` el 6 de noviembre de 2026. Esa autorización incluye publicar el código y su historial, no registros personales ni credenciales.

## Autenticación del entorno

La conexión `chatgpt-codex-connector` tiene permisos de escritura en Contents, Workflows y Actions. Permite subir el código y ejecutar el workflow. No tiene permisos de administración del repositorio ni de Pages: GitHub devuelve HTTP 403 al intentar cambiar la visibilidad o configurar Pages desde esta integración.

El secreto `BALANCE_DEPLOY_TOKEN` está configurado, pero las consultas HTTPS comprobadas siguen autenticándose mediante la integración de Codex. Crear otro token o ampliar repetidamente sus permisos no resuelve este bloqueo. No desactives el proxy ni la verificación TLS para evitarlo.

## Habilitación inicial por el propietario

Estas operaciones deben hacerse desde la sesión de GitHub del propietario cuando la integración no tenga permisos:

1. En **Settings → General → Danger Zone → Change repository visibility**, cambia `brenrojarq/account` a **Public**, conforme a la autorización indicada.
2. En **Settings → Pages → Build and deployment → Source**, selecciona **GitHub Actions**.

Si la visibilidad ya es pública o Pages ya está configurado, conserva el estado existente en lugar de repetir cambios.

## Desplegar y verificar

1. Consulta las ramas remotas antes de subir cambios. Integra cualquier trabajo nuevo sin sobrescribirlo ni usar force push.
2. Ejecuta `npm run build` y `npm test` desde `/workspace/account` para cambios de código.
3. Sube el commit a `main` mediante el proxy HTTPS de Git existente. No extraigas sus credenciales.
4. Con Pages habilitado, ejecuta manualmente `.github/workflows/pages.yml` sobre `main`. El workflow no publica automáticamente al hacer push.
5. Espera a que el workflow termine. Obtén la URL de su despliegue o entorno `github-pages`; si la API de Pages sigue restringida, consulta los resultados de Actions.
6. Verifica la URL HTTPS desde fuera del servidor de desarrollo: dashboard, navegación móvil y una exportación. Comparte el enlace solo cuando esté comprobado.

El workflow instala dependencias mediante `npm ci`, ejecuta pruebas y compilación, y publica `dist/`. La configuración relativa de Vite permite alojar la app bajo `/account/`.
