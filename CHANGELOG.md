# Changelog

## 0.1.2 (Preview)

- Con `@traza`, la IA responde en el chat a la pregunta con un texto de resumen, seguido del recorrido una sola vez y el botón «Visualizar flujo». Si lo necesita, puede seguir buscando y leyendo el código para contestar.
- «Visualizar pantalla» funciona con cualquier tecnología de vistas (JSP, Thymeleaf, HTML, React, Vue, Razor, PHP, Twig…).
  - La IA localiza la vista, sus includes y sus estilos, y devuelve una maqueta estática con datos de ejemplo inventados.
  - Mientras tanto, muestra qué está leyendo.
- «Base de datos» → «Reintentar»: si el mapa falla o sale vacío, la IA lee las clases de acceso a datos del flujo, localiza sus sentencias SQL y entidades, y deduce las tablas, las columnas y las relaciones que hay que pintar.
  - Muestra el progreso y se puede cancelar.
- Corregido: la petición de «Visualizar pantalla» sin Angular se descartaba antes de llegar a la IA.

## 0.1.1 (Preview)

- La IA de Copilot investiga el proyecto por su cuenta (búsqueda y lectura de solo lectura en todas las carpetas abiertas) antes de devolver el flujo o el cambio; Traza solo lo dibuja.
- Traza solo vuelve a pedir la respuesta cuando no se puede dibujar (formato), indicando qué partes fallan; ya no corrige ni descarta el contenido.
- Contexto multi-carpeta: roles front/back/datos y puente HTTP front → back como pista para el modelo.
- Las acciones del panel (simular, logs, base de datos) usan el modelo elegido en el chat de Copilot.
- «Base de datos» se genera en segundo plano al abrir el flujo y se reutiliza al reabrirlo.
- Explicación de la pestaña «Base de datos» a la escala de la tabla; cabecera más compacta.
- Recorrido: los pasos con algo visible para el usuario permiten «Visualizar pantalla».
- Traza solo se invoca explícitamente con `@traza`: se retiran la herramienta `#trazaFlujo` y las instrucciones para Copilot (`traza.copilotInstructions`).

## 0.1.0 (Preview)

Versión inicial de Traza, publicada como Preview.

- Participante de chat `@traza` con los comandos `/flujo` y `/cambio`.
- Herramienta de agente `#trazaFlujo`.
- Instrucciones para Copilot (`traza.copilotInstructions`).
- Panel con pestañas: Recorrido, Simular datos, Vista de pantalla, Analizar logs, Base de datos (PostgreSQL, MySQL y MariaDB, solo lectura de metadata) y Simular cambios.
- Apertura de archivos `*.flow.json`.
- Flujo de ejemplo incluido.
- Enlaces `vscode://ftejero21.traza/…`.
- Temas `traza` y `vscode`.
- Idiomas español e inglés.
- Elección de modelo de lenguaje (`traza.model`).
