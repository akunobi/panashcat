#!/bin/bash

echo "?? Iniciando subida a GitHub..."

# A¤adir cambios
git add .

# Preguntar por el mensaje del commit
echo "Escribe una nota sobre los cambios (ej: Arreglado login):"
read mensaje

# Hacer commit
git commit -m "$mensaje"

# Subir
echo "??  Subiendo a GitHub..."
git push origin main

echo "? ­Listo! Render deber¡a actualizarse en breve."
