$ErrorActionPreference = 'Stop'

function Invoke-JsonCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$CurlArgs
  )

  Write-Host "Running: $Name"
  $result = & curl.exe @CurlArgs
  if (-not $result) {
    throw "No response for $Name"
  }
  Write-Host $result
}

Invoke-JsonCheck -Name "AI method contract" -CurlArgs @(
  '-s', '-L', '-X', 'GET',
  'http://localhost:3000/api/ai-meal-plan',
  '-w', '\nHTTP:%{http_code}\n'
)
Invoke-JsonCheck -Name "AI invalid body contract" -CurlArgs @(
  '-s', '-L', '-X', 'POST',
  'http://localhost:3000/api/ai-meal-plan',
  '-H', 'Content-Type: application/json',
  '-d', '{}',
  '-w', '\nHTTP:%{http_code}\n'
)
Invoke-JsonCheck -Name "Recipe invalid query contract" -CurlArgs @(
  '-s', '-L', '-X', 'GET',
  'http://localhost:3000/api/recipe',
  '-w', '\nHTTP:%{http_code}\n'
)

Write-Host "Stability smoke checks completed."
