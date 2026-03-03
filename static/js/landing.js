    var bootstrap=window.LectureProcessorBootstrap||{};
    var auth=bootstrap.getAuth?bootstrap.getAuth():firebase.auth();
    var topbarUtils=window.LectureProcessorTopbar||{};
    var dashboardBtnLabel=document.getElementById('dashboard-btn-label');
    if(topbarUtils.bindAuthCta){
      topbarUtils.bindAuthCta(auth,{
        labelEl:dashboardBtnLabel,
        signedInText:'Dashboard',
        signedOutText:'Sign in'
      });
    }else{
      auth.onAuthStateChanged(function(user){
        dashboardBtnLabel.textContent=user?'Dashboard':'Sign in';
      });
    }
