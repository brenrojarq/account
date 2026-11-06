# Publicar Balance

El sitio es estático. La publicación del entorno de Codex no publica la web.

## Estado comprobado

- El proyecto compila y las 10 pruebas financieras pasan.
- `brenrojarq/account` es privado y está vacío en GitHub.
- La conexión integrada permite consultar el repositorio, pero GitHub rechaza crear o administrar Pages con HTTP 403: `Resource not accessible by integration`.
- La red del entorno debe permitir `github.com` para Git, `registry.npmjs.org` para instalar dependencias, `api.github.com` para configurar el despliegue y `brenrojarq.github.io` para comprobar el sitio.

## Credencial que falta

Introduce un token de GitHub con alcance únicamente al repositorio `brenrojarq/account` en el secreto **BALANCE_DEPLOY_TOKEN** de la configuración del entorno. No lo pegues en el chat ni lo añadas a archivos del repositorio.

Para el workflow de publicación ya preparado, el token de acceso detallado necesita:

- **Contents: Read and write**, para subir el proyecto.
- **Workflows: Read and write**, para subir `.github/workflows/pages.yml`.
- **Actions: Read and write**, para ejecutar y consultar el workflow manual.
- **Pages: Read and write**, para habilitar Pages y consultar el despliegue.

No se necesita cambiar la visibilidad del repositorio. GitHub Pages en un repositorio privado requiere un plan que lo admita. Si GitHub informa que el plan no lo permite, no conviertas el repositorio en público automáticamente: utiliza otro alojamiento autorizado o solicita esa decisión al usuario.

## Continuar cuando exista acceso

1. Comprueba la presencia del secreto sin imprimir su valor y selecciona esa credencial solo para las operaciones de despliegue. Conserva el proxy y la verificación TLS del entorno.
2. Vuelve a consultar las ramas remotas. Si apareció trabajo nuevo, intégralo sin sobrescribirlo ni usar force push.
3. Sube el commit local con el proyecto a `main` de `brenrojarq/account`.
4. Habilita GitHub Pages con `build_type: workflow`.
5. Ejecuta manualmente `.github/workflows/pages.yml` sobre `main`. El workflow no publica automáticamente al hacer push.
6. Espera al resultado y consulta la URL devuelta por GitHub. No presentes la URL esperada como un sitio existente antes de comprobarla.
7. Abre la URL HTTPS, verifica el dashboard y una exportación en una vista móvil y comparte únicamente el enlace que se haya verificado.

Los registros personales permanecen en el navegador. El sitio publicado contiene la aplicación y los datos de ejemplo, sin credenciales ni registros financieros del usuario.
